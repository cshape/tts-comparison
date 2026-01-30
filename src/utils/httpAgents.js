import https from 'https';
import axios from 'axios';

/**
 * HTTP Agents Manager
 * Manages shared HTTPS agents with keep-alive for all TTS providers.
 * Reusing TCP/TLS connections reduces latency by 100-300ms per request.
 */

const agents = {
    inworld: null,
    cartesia: null,
    elevenlabs: null,
    hume: null
};

/**
 * Create an HTTPS agent with keep-alive settings
 * @param {string} name - Provider name for logging
 * @returns {https.Agent} The HTTPS agent
 */
function createAgent(name) {
    const agent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 60000
    });
    console.log(`[HttpAgents] Created ${name} agent with keep-alive`);
    return agent;
}

/**
 * Get or create the shared HTTPS agent for a provider
 * @param {string} provider - Provider name (inworld, cartesia, elevenlabs, hume)
 * @returns {https.Agent} The shared HTTPS agent
 */
export function getAgent(provider) {
    if (!agents[provider]) {
        agents[provider] = createAgent(provider);
    }
    return agents[provider];
}

// Convenience functions for each provider
export function getInworldAgent() { return getAgent('inworld'); }
export function getCartesiaAgent() { return getAgent('cartesia'); }
export function getElevenLabsAgent() { return getAgent('elevenlabs'); }
export function getHumeAgent() { return getAgent('hume'); }

/**
 * Warm up a provider's connection by making a minimal request
 * @param {string} provider - Provider name
 * @returns {Promise<{success: boolean, warmupTimeMs?: number, error?: string}>}
 */
async function warmupProvider(provider) {
    const startTime = Date.now();

    try {
        let config;

        switch (provider) {
            case 'inworld':
                if (!process.env.INWORLD_API_KEY ||
                    process.env.INWORLD_API_KEY === 'your_inworld_api_key_here' ||
                    process.env.INWORLD_API_KEY.trim() === '') {
                    return { success: false, error: 'No valid API key configured' };
                }
                config = {
                    method: 'post',
                    url: 'https://api.inworld.ai/tts/v1/voice:stream',
                    data: { text: '', voiceId: 'Alex', modelId: 'inworld-tts-1.5-mini', audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 44100 } },
                    headers: { 'Authorization': `Basic ${process.env.INWORLD_API_KEY}`, 'Content-Type': 'application/json' }
                };
                break;

            case 'cartesia':
                if (!process.env.CARTESIA_API_KEY ||
                    process.env.CARTESIA_API_KEY === 'your_cartesia_api_key_here' ||
                    process.env.CARTESIA_API_KEY.trim() === '') {
                    return { success: false, error: 'No valid API key configured' };
                }
                config = {
                    method: 'post',
                    url: 'https://api.cartesia.ai/tts/sse',
                    data: { model_id: 'sonic-2', transcript: '', voice: { mode: 'id', id: 'a0e99841-438c-4a64-b679-ae501e7d6091' }, output_format: { container: 'raw', encoding: 'pcm_f32le', sample_rate: 44100 } },
                    headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': process.env.CARTESIA_API_KEY, 'Content-Type': 'application/json' }
                };
                break;

            case 'elevenlabs':
                if (!process.env.ELEVENLABS_API_KEY ||
                    process.env.ELEVENLABS_API_KEY === 'your_elevenlabs_api_key_here' ||
                    process.env.ELEVENLABS_API_KEY.trim() === '') {
                    return { success: false, error: 'No valid API key configured' };
                }
                // Use a simple GET request to their API to establish connection
                config = {
                    method: 'get',
                    url: 'https://api.elevenlabs.io/v1/voices',
                    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
                };
                break;

            case 'hume':
                if (!process.env.HUME_API_KEY ||
                    process.env.HUME_API_KEY === 'your_hume_api_key_here' ||
                    process.env.HUME_API_KEY.trim() === '') {
                    return { success: false, error: 'No valid API key configured' };
                }
                config = {
                    method: 'post',
                    url: 'https://api.hume.ai/v0/tts/stream/json',
                    data: { utterances: [{ text: '', voice: { name: 'Male English Actor', provider: 'HUME_AI' } }] },
                    headers: { 'X-Hume-Api-Key': process.env.HUME_API_KEY, 'Content-Type': 'application/json' }
                };
                break;

            default:
                return { success: false, error: `Unknown provider: ${provider}` };
        }

        await axios({
            ...config,
            httpsAgent: getAgent(provider),
            timeout: 10000,
            validateStatus: () => true  // Accept any status - we just want connection
        });

        const warmupTimeMs = Date.now() - startTime;
        console.log(`[HttpAgents] ${provider} connection warmed up in ${warmupTimeMs}ms`);
        return { success: true, warmupTimeMs, provider };

    } catch (error) {
        const warmupTimeMs = Date.now() - startTime;
        console.error(`[HttpAgents] ${provider} warmup failed after ${warmupTimeMs}ms:`, error.message);
        return { success: false, error: error.message, warmupTimeMs, provider };
    }
}

// Export individual warmup functions
export async function warmupInworldConnection() { return warmupProvider('inworld'); }
export async function warmupCartesiaConnection() { return warmupProvider('cartesia'); }
export async function warmupElevenLabsConnection() { return warmupProvider('elevenlabs'); }
export async function warmupHumeConnection() { return warmupProvider('hume'); }

/**
 * Warm up all provider connections in parallel
 * @returns {Promise<{results: Object[], totalTimeMs: number}>}
 */
export async function warmupAllConnections() {
    const startTime = Date.now();
    const results = await Promise.all([
        warmupProvider('inworld'),
        warmupProvider('cartesia'),
        warmupProvider('elevenlabs'),
        warmupProvider('hume')
    ]);
    const totalTimeMs = Date.now() - startTime;
    console.log(`[HttpAgents] All connections warmed up in ${totalTimeMs}ms`);
    return { results, totalTimeMs };
}

/**
 * Destroy a specific provider's agent
 * @param {string} provider - Provider name
 */
export function destroyAgent(provider) {
    if (agents[provider]) {
        agents[provider].destroy();
        agents[provider] = null;
        console.log(`[HttpAgents] ${provider} agent destroyed`);
    }
}

/**
 * Destroy all agents (call on server shutdown)
 */
export function destroyAllAgents() {
    for (const provider of Object.keys(agents)) {
        destroyAgent(provider);
    }
    console.log('[HttpAgents] All agents destroyed');
}

// Legacy export for backwards compatibility
export const destroyInworldAgent = () => destroyAgent('inworld');
