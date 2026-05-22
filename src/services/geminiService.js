import { GoogleGenAI } from '@google/genai';

/**
 * Gemini TTS Service
 * Uses Google's Gemini speech-generation API (model: gemini-3.1-flash-tts-preview).
 *
 * The Gemini TTS API returns 24kHz, 16-bit signed PCM (mono) inline as base64.
 * We wrap it with a 44-byte WAV header before storing so the browser and ffmpeg
 * can read it without extra transcoding.
 */

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

function pcmToWav(pcmBuffer) {
    const byteRate = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8;
    const blockAlign = CHANNELS * BITS_PER_SAMPLE / 8;
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);              // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);               // AudioFormat (PCM = 1)
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

class GeminiService {
    constructor(audioManager, vadService = null) {
        this.audioManager = audioManager;
        this.vadService = vadService;
    }

    hasValidApiKey() {
        return process.env.GEMINI_API_KEY &&
               process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here' &&
               process.env.GEMINI_API_KEY.trim() !== '';
    }

    async process(text, sendUpdate, sessionId) {
        const startTime = Date.now();

        try {
            if (!this.hasValidApiKey()) {
                console.log(' Gemini: Skipping - no valid API key (0ms)');
                return { timeToFirstByte: 99999, hasAudio: false };
            }

            sendUpdate({
                type: 'model_update',
                model: 'gemini',
                stage: 'processing',
                progress: 0,
                timestamp: startTime
            });

            console.log(' Gemini: Using real API');
            const result = await this.processReal(text, sendUpdate, sessionId);

            sendUpdate({
                type: 'model_update',
                model: 'gemini',
                stage: 'complete',
                duration: Date.now() - startTime,
                hasAudio: result?.hasAudio || false,
                timestamp: Date.now()
            });

            return result;

        } catch (error) {
            console.error('Gemini TTS Error:', error.message);
            sendUpdate({
                type: 'model_update',
                model: 'gemini',
                stage: 'error',
                error: error.message,
                timestamp: Date.now()
            });
            throw error;
        }
    }

    async processReal(text, sendUpdate, sessionId) {
        const requestStartTime = Date.now();
        let timeToFirstByte = null;

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const voiceName = process.env.GEMINI_VOICE_ID || 'Charon';
        const modelId = 'gemini-3.1-flash-tts-preview';

        const config = {
            responseModalities: ['AUDIO'],
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName }
                }
            }
        };

        const contents = [{ parts: [{ text }] }];

        // Use streaming to capture time-to-first-byte
        const stream = await ai.models.generateContentStream({
            model: modelId,
            contents,
            config
        });

        const pcmChunks = [];
        let totalAudioChunks = 0;
        let firstAudioChunkReceived = false;

        for await (const chunk of stream) {
            const parts = chunk?.candidates?.[0]?.content?.parts;
            if (!parts) continue;

            for (const part of parts) {
                const b64 = part?.inlineData?.data;
                if (!b64) continue;

                const pcm = Buffer.from(b64, 'base64');
                pcmChunks.push(pcm);
                totalAudioChunks++;

                if (!firstAudioChunkReceived) {
                    firstAudioChunkReceived = true;
                    timeToFirstByte = Date.now() - requestStartTime;
                    console.log(`Gemini: First chunk received after ${timeToFirstByte}ms - Size: ${pcm.length} bytes`);

                    sendUpdate({
                        type: 'model_update',
                        model: 'gemini',
                        stage: 'processing',
                        progress: 100,
                        timestamp: Date.now()
                    });

                    sendUpdate({
                        type: 'model_update',
                        model: 'gemini',
                        stage: 'speech',
                        progress: 0,
                        timestamp: Date.now()
                    });
                }
            }
        }

        const hasAudio = pcmChunks.length > 0;
        let totalAudioDuration = 0;

        if (hasAudio) {
            const pcmBuffer = Buffer.concat(pcmChunks);
            const wavBuffer = pcmToWav(pcmBuffer);

            // Duration in ms = samples / sample_rate * 1000
            const sampleCount = pcmBuffer.length / (BITS_PER_SAMPLE / 8) / CHANNELS;
            totalAudioDuration = Math.round((sampleCount / SAMPLE_RATE) * 1000);

            this.audioManager.storeAudio(sessionId, 'gemini', wavBuffer);
            console.log(`Gemini: Total chunks: ${totalAudioChunks}, audio duration: ${totalAudioDuration}ms`);
            this.audioManager.saveCompleteAudio(sessionId, 'gemini', wavBuffer);
        } else if (timeToFirstByte === null) {
            // No audio chunks ever arrived
            timeToFirstByte = Date.now() - requestStartTime;
        }

        sendUpdate({
            type: 'model_update',
            model: 'gemini',
            stage: 'speech',
            progress: 100,
            duration: totalAudioDuration,
            totalDuration: totalAudioDuration,
            timestamp: Date.now()
        });

        return { timeToFirstByte, hasAudio };
    }
}

export default GeminiService;
