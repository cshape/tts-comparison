import axios from 'axios';
import { getInworldAgent } from '../utils/httpAgents.js';

/**
 * Inworld TTS-2 Service
 * Handles Inworld text-to-speech processing using the inworld-tts-2 model with Jason voice
 */

class InworldTts2Service {
    constructor(audioManager, vadService = null) {
        this.audioManager = audioManager;
        this.vadService = vadService;
    }

    /**
     * Check if API key is valid
     * @returns {boolean} True if API key is valid
     */
    hasValidApiKey() {
        return process.env.INWORLD_API_KEY &&
               process.env.INWORLD_API_KEY !== 'your_inworld_api_key_here' &&
               process.env.INWORLD_API_KEY.trim() !== '';
    }

    /**
     * Process Inworld TTS-2
     * @param {string} text - Text to convert to speech
     * @param {Function} sendUpdate - Function to send progress updates
     * @param {string} sessionId - Session ID
     */
    async process(text, sendUpdate, sessionId) {
        const startTime = Date.now();

        try {
            if (!this.hasValidApiKey()) {
                console.log(' Inworld TTS-2: Skipping - no valid API key (0ms)');
                return { timeToFirstByte: 99999, hasAudio: false };
            }

            // Send processing start
            sendUpdate({
                type: 'model_update',
                model: 'inworldtts2',
                stage: 'processing',
                progress: 0,
                timestamp: startTime
            });

            console.log(' Inworld TTS-2: Using real API');
            const result = await this.processReal(text, sendUpdate, sessionId);

            // Send completion
            sendUpdate({
                type: 'model_update',
                model: 'inworldtts2',
                stage: 'complete',
                duration: Date.now() - startTime,
                hasAudio: result?.hasAudio || false,
                timestamp: Date.now()
            });

            return result;

        } catch (error) {
            console.error('Inworld TTS-2 Error:', error.message);
            sendUpdate({
                type: 'model_update',
                model: 'inworldtts2',
                stage: 'error',
                error: error.message,
                timestamp: Date.now()
            });
            throw error;
        }
    }

    /**
     * Process real Inworld API call
     * @param {string} text - Text to convert to speech
     * @param {Function} sendUpdate - Function to send progress updates
     * @param {string} sessionId - Session ID
     */
    async processReal(text, sendUpdate, sessionId) {
        // Track when we start the request for TTFB calculation
        const requestStartTime = Date.now();
        let timeToFirstByte = null;

        // Prepare request body
        const requestBody = {
            text: text,
            voiceId: process.env.INWORLD_TTS2_VOICE_ID || 'Jason',
            modelId: 'inworld-tts-2',
            audioConfig: {
                audioEncoding: 'MP3',
                sampleRateHertz: 44100  // Standardized to 44.1kHz for better browser compatibility
            },
            temperature: 1.1
        };

        // Create Basic auth header - Inworld expects the API key directly, not base64 encoded
        const authHeader = `Basic ${process.env.INWORLD_API_KEY}`;

        const response = await axios({
            method: 'post',
            url: 'https://api.inworld.ai/tts/v1/voice:stream',
            data: requestBody,
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            httpsAgent: getInworldAgent(),
            responseType: 'stream',
            validateStatus: () => true
        });

        // Check for error responses
        if (response.status >= 400) {
            let errorMessage = `Inworld TTS-2 API error: ${response.status}`;
            try {
                const chunks = [];
                for await (const chunk of response.data) {
                    chunks.push(chunk);
                }
                const errorBody = Buffer.concat(chunks).toString();
                errorMessage += ` - ${errorBody}`;
            } catch (e) {
                // Ignore error reading error body
            }
            throw new Error(errorMessage);
        }

        // Handle streaming response
        let bytesReceived = 0;
        let firstAudioChunkReceived = false;
        let audioChunks = [];
        let totalAudioChunks = 0;
        let buffer = '';
        let totalAudioDuration = 0;
        let firstWordTimestamp = null;
        let lastWordTimestamp = 0;

        response.data.on('data', (chunk) => {
            bytesReceived += chunk.length;
            buffer += chunk.toString();

            // Parse streaming JSON responses line by line
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim()) {
                    try {
                        const data = JSON.parse(line);

                        if (data.result && data.result.audioContent) {
                            // Decode base64 audio content
                            const audioData = Buffer.from(data.result.audioContent, 'base64');
                            audioChunks.push(audioData);
                            totalAudioChunks++;

                            if (!firstAudioChunkReceived) {
                                firstAudioChunkReceived = true;
                                timeToFirstByte = Date.now() - requestStartTime;
                                console.log(`Inworld TTS-2: First chunk received after ${timeToFirstByte}ms - Size: ${audioData.length} bytes`);

                                // Mark processing as complete when first chunk arrives
                                sendUpdate({
                                    type: 'model_update',
                                    model: 'inworldtts2',
                                    stage: 'processing',
                                    progress: 100,
                                    timestamp: Date.now()
                                });

                                // Save first chunk for analysis only if VAD service is available
                                if (this.vadService) {
                                    this.audioManager.saveChunkToDisk(sessionId, 'inworldtts2', audioData, totalAudioChunks, 'first_chunk');
                                }

                                // Inworld goes straight to speech (no silent prefix)
                                console.log(` Inworld TTS-2: Starting speech generation`);
                                sendUpdate({
                                    type: 'model_update',
                                    model: 'inworldtts2',
                                    stage: 'speech',
                                    progress: 0,
                                    timestamp: Date.now()
                                });
                            }
                        }

                        // Process word timing data if available
                        if (data.result && data.result.words) {
                            const words = data.result.words;

                            if (words.length > 0) {
                                const firstWord = words[0];
                                const lastWord = words[words.length - 1];

                                if (firstWordTimestamp === null && firstWord.startTime) {
                                    firstWordTimestamp = parseFloat(firstWord.startTime);
                                }

                                if (lastWord.endTime) {
                                    lastWordTimestamp = parseFloat(lastWord.endTime);
                                    totalAudioDuration = Math.round(lastWordTimestamp * 1000);

                                    const totalWords = text.split(/\s+/).length;
                                    const processedWords = words.length;
                                    const speechProgress = Math.min((processedWords / Math.max(totalWords, 1)) * 100, 95);

                                    console.log(` Inworld TTS-2: Processed ${processedWords}/${totalWords} words, duration: ${totalAudioDuration}ms`);

                                    sendUpdate({
                                        type: 'model_update',
                                        model: 'inworldtts2',
                                        stage: 'speech',
                                        progress: speechProgress,
                                        duration: Math.round((lastWordTimestamp - (firstWordTimestamp || 0)) * 1000),
                                        totalDuration: totalAudioDuration,
                                        bytesReceived: audioChunks.reduce((sum, chunk) => sum + chunk.length, 0),
                                        totalChunks: totalAudioChunks,
                                        timestamp: Date.now()
                                    });
                                }
                            }
                        }

                        // Fallback: if no word timing, estimate duration and use chunk-based progress
                        if (!data.result?.words && data.result?.audioContent) {
                            const estimatedDurationMs = Math.round((text.split(/\s+/).length / 150) * 60 * 1000);
                            const speechProgress = Math.min((totalAudioChunks / Math.max(2, 1)) * 100, 95);

                            if (totalAudioDuration === 0) {
                                totalAudioDuration = estimatedDurationMs;
                                console.log(` Inworld TTS-2: Using estimated duration: ${estimatedDurationMs}ms for ${text.split(/\s+/).length} words`);
                            }

                            sendUpdate({
                                type: 'model_update',
                                model: 'inworldtts2',
                                stage: 'speech',
                                progress: speechProgress,
                                duration: Math.round(totalAudioDuration * (speechProgress / 100)),
                                totalDuration: totalAudioDuration,
                                bytesReceived: audioChunks.reduce((sum, chunk) => sum + chunk.length, 0),
                                totalChunks: totalAudioChunks,
                                timestamp: Date.now()
                            });
                        }
                    } catch (parseError) {
                        console.log('Parse error for line:', line, parseError.message);
                    }
                }
            }
        });

        await new Promise((resolve, reject) => {
        response.data.on('end', async () => {
            let completeAudioPath = null;
            let hasAudio = false;

            if (audioChunks.length > 0) {
                const audioBuffer = Buffer.concat(audioChunks);
                this.audioManager.storeAudio(sessionId, 'inworldtts2', audioBuffer);
                hasAudio = true;
                    console.log(`Inworld TTS-2: Total audio duration (estimated): ${totalAudioDuration}ms`);
                    console.log(`Total chunks: ${totalAudioChunks}`);

                    completeAudioPath = this.audioManager.saveCompleteAudio(sessionId, 'inworldtts2', audioBuffer);

                    let accurateDuration = totalAudioDuration;
                    if (completeAudioPath) {
                        try {
                            const ffmpegDuration = await this.audioManager.getAudioDuration(sessionId, 'inworldtts2', 'complete');
                            if (ffmpegDuration !== null) {
                                accurateDuration = ffmpegDuration;
                                console.log(` Inworld TTS-2: Corrected duration from ${totalAudioDuration}ms to ${accurateDuration}ms (complete file)`);
                            }
                        } catch (error) {
                            console.warn(`Inworld TTS-2: Could not get accurate duration from complete file, using estimated: ${error.message}`);
                        }
                    }

                    const finalSpeechDuration = firstWordTimestamp !== null && lastWordTimestamp > 0
                        ? Math.round((lastWordTimestamp - firstWordTimestamp) * 1000)
                        : accurateDuration;

                    sendUpdate({
                        type: 'model_update',
                        model: 'inworldtts2',
                        stage: 'speech',
                        progress: 100,
                        duration: finalSpeechDuration,
                        totalDuration: accurateDuration,
                        timestamp: Date.now()
                    });
                } else {
                    if (totalAudioDuration === 0) {
                        totalAudioDuration = Math.round((text.split(/\s+/).length / 150) * 60 * 1000);
                        console.log(` Inworld TTS-2: Final fallback duration estimate: ${totalAudioDuration}ms`);
                    }

                    const finalSpeechDuration = firstWordTimestamp !== null && lastWordTimestamp > 0
                        ? Math.round((lastWordTimestamp - firstWordTimestamp) * 1000)
                        : totalAudioDuration;

                    sendUpdate({
                        type: 'model_update',
                        model: 'inworldtts2',
                        stage: 'speech',
                        progress: 100,
                        duration: finalSpeechDuration,
                        totalDuration: totalAudioDuration,
                        timestamp: Date.now()
                    });
                }

                resolve();
            });
            response.data.on('error', reject);
        });

        return { timeToFirstByte, hasAudio: audioChunks.length > 0 };
    }

    /**
     * Simulate Inworld TTS-2 when no API key is provided
     */
    async simulate(text, sendUpdate, startTime, sessionId) {
        await new Promise(resolve => setTimeout(resolve, 250));

        sendUpdate({
            type: 'model_update',
            model: 'inworldtts2',
            stage: 'processing',
            progress: 100,
            timestamp: Date.now()
        });

        sendUpdate({
            type: 'model_update',
            model: 'inworldtts2',
            stage: 'speech',
            progress: 0,
            timestamp: Date.now()
        });

        await new Promise(resolve => setTimeout(resolve, 75));

        const streamDuration = Math.min(text.length * 28, 2800);
        const chunks = 12;
        for (let i = 0; i <= chunks; i++) {
            sendUpdate({
                type: 'model_update',
                model: 'inworldtts2',
                stage: 'speech',
                progress: (i / chunks) * 100,
                timestamp: Date.now()
            });
            await new Promise(resolve => setTimeout(resolve, streamDuration / chunks));
        }
    }

    /**
     * Perform VAD analysis on complete audio file
     */
    async performVADAnalysisOnComplete(sessionId, model, sendUpdate) {
        try {
            console.log(`${model}: Starting VAD analysis on complete audio...`);

            const vadResult = await this.vadService.analyzeCompleteAudioFile(sessionId, model, this.audioManager);

            if (vadResult.success) {
                console.log(`${model}: VAD detected ${vadResult.msBeforeVoice}ms of silence before speech (complete audio)`);

                sendUpdate({
                    type: 'vad_analysis',
                    model: model,
                    vadResult: vadResult,
                    timestamp: Date.now()
                });
            } else {
                console.log(`${model}: VAD analysis failed - ${vadResult.message}`);
            }

        } catch (error) {
            console.error(`${model}: VAD analysis error:`, error);
        }
    }

    /**
     * Perform VAD analysis on first chunk (legacy)
     */
    async performVADAnalysis(sessionId, model, sendUpdate) {
        try {
            console.log(`${model}: Starting VAD analysis...`);

            const audioDir = this.audioManager.getAudioDirectory();
            const audioFilePath = `${audioDir}/${sessionId}_${model}_first_chunk.mp3`;

            const vadResult = await this.vadService.analyzeAudioFile(audioFilePath, sessionId, model, this.audioManager);

            if (vadResult.success) {
                console.log(`${model}: VAD detected ${vadResult.msBeforeVoice}ms of silence before speech`);

                sendUpdate({
                    type: 'vad_analysis',
                    model: model,
                    vadResult: vadResult,
                    timestamp: Date.now()
                });
            } else {
                console.log(`${model}: VAD analysis failed - ${vadResult.message}`);
            }

        } catch (error) {
            console.error(`${model}: VAD analysis error:`, error);
        }
    }
}

export default InworldTts2Service;
