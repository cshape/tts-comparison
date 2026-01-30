import https from 'https';
import axios from 'axios';

let inworldAgent = null;

/**
 * Get or create the shared HTTPS agent for Inworld API calls.
 * Uses HTTP keep-alive to reuse TCP/TLS connections across requests.
 * @returns {https.Agent} The shared HTTPS agent
 */
export function getInworldAgent() {
    if (!inworldAgent) {
        inworldAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: 30000,
            maxSockets: 10,
            maxFreeSockets: 5,
            timeout: 60000
        });
        console.log('[InworldAgent] Created new HTTPS agent with keep-alive');
    }
    return inworldAgent;
}

/**
 * Warm up the Inworld connection by making a minimal request.
 * This establishes TCP+TLS connection so subsequent requests are faster.
 * @returns {Promise<{success: boolean, warmupTimeMs?: number, error?: string}>}
 */
export async function warmupInworldConnection() {
    const startTime = Date.now();

    try {
        // Check if API key is configured
        if (!process.env.INWORLD_API_KEY ||
            process.env.INWORLD_API_KEY === 'your_inworld_api_key_here' ||
            process.env.INWORLD_API_KEY.trim() === '') {
            console.log('[InworldAgent] Warmup skipped - no valid API key');
            return { success: false, error: 'No valid API key configured' };
        }

        // Make a HEAD request or minimal request to establish connection
        // Using a simple GET to an endpoint that exists (even if it returns an error)
        // The goal is just to establish the TCP+TLS handshake
        const authHeader = `Basic ${process.env.INWORLD_API_KEY}`;

        await axios({
            method: 'post',
            url: 'https://api.inworld.ai/tts/v1/voice:stream',
            data: {
                text: '',  // Empty text - will return error but establishes connection
                voiceId: 'Alex',
                modelId: 'inworld-tts-1.5-mini',
                audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 44100 }
            },
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            httpsAgent: getInworldAgent(),
            timeout: 10000,
            validateStatus: () => true  // Accept any status - we just want connection
        });

        const warmupTimeMs = Date.now() - startTime;
        console.log(`[InworldAgent] Connection warmed up in ${warmupTimeMs}ms`);

        return { success: true, warmupTimeMs };
    } catch (error) {
        const warmupTimeMs = Date.now() - startTime;
        console.error(`[InworldAgent] Warmup failed after ${warmupTimeMs}ms:`, error.message);
        return { success: false, error: error.message, warmupTimeMs };
    }
}

/**
 * Destroy the shared HTTPS agent and clean up connections.
 * Call this on server shutdown.
 */
export function destroyInworldAgent() {
    if (inworldAgent) {
        inworldAgent.destroy();
        inworldAgent = null;
        console.log('[InworldAgent] Agent destroyed');
    }
}
