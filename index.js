import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { GoogleGenAI } from '@google/genai';

// Initialize the official Gemini client (reads process.env.GEMINI_API_KEY automatically)
const ai = new GoogleGenAI({});

// ==========================================
// 1. API HELPER FUNCTIONS (IGDB, TMDB, GEMINI)
// ==========================================

async function searchIGDB(query) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const accessToken = process.env.IGDB_ACCESS_TOKEN;

    if (!clientId || !accessToken) {
        return { text: '⚠️ IGDB credentials are missing in your .env file.' };
    }

    try {
        console.log(`[IGDB API] Querying games for: "${query}"`);

        const igdbRes = await fetch('https://api.igdb.com/v4/games', {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
            },
            body: `search "${query}"; fields name, summary, total_rating, first_release_date, cover.image_id, platforms.name, id; limit 1;`
        });

        const rawData = await igdbRes.json();
        console.log('[IGDB API] Raw Response Data:', JSON.stringify(rawData, null, 2));

        if (!rawData || rawData.length === 0) {
            return { text: `❌ No games found matching "${query}" on IGDB.` };
        }

        const game = rawData[0];
        const releaseYear = game.first_release_date ? new Date(game.first_release_date * 1000).getFullYear() : 'Unknown';
        const rating = game.total_rating ? Math.round(game.total_rating) + '/100' : 'N/A';
        const summary = game.summary ? game.summary.slice(0, 300) + '...' : 'No summary available.';
        const platformsList = game.platforms ? game.platforms.map(p => p.name).join(', ') : 'Not specified';
        
        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/games/${game.id}`;
        
        const captionText = `🎮 *${game.name}* (${releaseYear})\n\n⭐ *Rating:* ${rating}\n\n🖥️ *Platforms:* ${platformsList}\n\n📝 *Overview:* ${summary}${sharknyLink}`;

        let imageUrl = game.cover?.image_id ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg` : null;

        return { image: imageUrl ? { url: imageUrl } : null, text: captionText };
    } catch (error) {
        console.error('IGDB Error:', error);
        return { text: '❌ Failed to fetch game from IGDB.' };
    }
}

async function searchTMDB(mediaType, query) {
    const tmdbToken = process.env.TMDB_ACCESS_TOKEN;
    if (!tmdbToken) {
        return { text: '⚠️ TMDB access token is missing in your .env file.' };
    }

    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const searchUrl = `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(query)}`;

        console.log(`[TMDB API] Searching ${endpoint} for: "${query}"`);

        const searchRes = await fetch(searchUrl, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });

        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) {
            return { text: `❌ No results found matching "${query}" on TMDB.` };
        }

        // Get the ID of the first match from search results
        const firstItem = searchData.results[0];
        const itemId = firstItem.id;

        // Fetch full details endpoint to get exact runtime (movies) or seasons/episodes (tv)
        const detailsUrl = `https://api.themoviedb.org/3/${endpoint}/${itemId}`;
        console.log(`[TMDB API] Fetching details for ID ${itemId} from ${detailsUrl}`);

        const detailsRes = await fetch(detailsUrl, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });

        const item = await detailsRes.json();
        console.log('[TMDB API] Raw Details Data:', JSON.stringify(item, null, 2));

        const title = item.title || item.name || 'Unknown Title';
        const rawDate = item.release_date || item.first_air_date;
        const releaseYear = rawDate ? new Date(rawDate).getFullYear() : 'Unknown';
        const rating = item.vote_average ? item.vote_average.toFixed(1) + '/10' : 'N/A';
        const overview = item.overview ? item.overview.slice(0, 300) + '...' : 'No overview available.';

        let extraStats = '';
        if (mediaType === 'tv') {
            const seasons = item.number_of_seasons || 'N/A';
            const episodes = item.number_of_episodes || 'N/A';
            extraStats = `\n\n📺 *Seasons:* ${seasons} | *Episodes:* ${episodes}`;
        } else {
            const runtimeMinutes = item.runtime ? `${item.runtime} mins` : 'N/A';
            extraStats = `\n\n⏱️ *Runtime:* ${runtimeMinutes}`;
        }

        const typeEmoji = mediaType === 'tv' ? '📺' : '🎬';
        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/sharkny/tv/${item.id}`;

        const captionText = `${typeEmoji} *${title}* (${releaseYear})\n\n⭐ *Rating:* ${rating}${extraStats}\n\n📝 *Overview:* ${overview}${sharknyLink}`;

        let imageUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

        return { image: imageUrl ? { url: imageUrl } : null, text: captionText };
    } catch (error) {
        console.error('TMDB Error:', error);
        return { text: '❌ Failed to fetch media details from TMDB.' };
    }
}

async function handleAI(args, msg, sock) {
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMessage = contextInfo?.quotedMessage;
    
    let quotedText = '';
    let quotedImageBuffer = null;

    if (quotedMessage) {
        quotedText = 
            quotedMessage.conversation || 
            quotedMessage.extendedTextMessage?.text || 
            quotedMessage.imageMessage?.caption || 
            '';

        if (quotedMessage.imageMessage) {
            try {
                console.log('[Gemini API] Downloading quoted image for analysis...');
                const stream = await downloadMediaMessage(
                    { message: quotedMessage },
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
                quotedImageBuffer = stream;
            } catch (err) {
                console.error('Failed to download image from quoted message:', err);
            }
        }
    }

    const isImageGenerationRequest = 
        args.toLowerCase().startsWith('generate') || 
        args.toLowerCase().startsWith('draw') ||
        args.toLowerCase().includes('image of');

    // Workflow A: Image Generation via Imagen
    if (isImageGenerationRequest) {
        const imagePrompt = args.replace(/^(generate|draw)\s+/i, '').trim();
        console.log(`[Imagen] Generating image for prompt: "${imagePrompt}"`);

        try {
            const imageResponse = await ai.models.generateImages({
                model: 'imagen-3.0-generate-002',
                prompt: imagePrompt,
                config: {
                    numberOfImages: 1,
                    outputMimeType: 'image/jpeg',
                    aspectRatio: '1:1',
                },
            });

            const base64Image = imageResponse.generatedImages[0].image.imageBytes;
            const imageBuffer = Buffer.from(base64Image, 'base64');

            return {
                image: imageBuffer,
                caption: `🎨 *Generated for:* "${imagePrompt}"`
            };
        } catch (error) {
            console.error('Image Generation Error:', error);
            return { text: '❌ Failed to generate image.' };
        }
    }

    // Workflow B: Multimodal Gemini Chat with Google Search Grounding
    let contents = [];

    if (quotedImageBuffer) {
        contents.push({
            inlineData: {
                data: quotedImageBuffer.toString('base64'),
                mimeType: 'image/jpeg'
            }
        });
    }

    let textPrompt = '';
    if (quotedText && args) {
        textPrompt = `${args}\n\nContext:\n"""\n${quotedText}\n"""`;
    } else if (quotedText && !args) {
        textPrompt = `Analyze or respond to this message/content:\n"""\n${quotedText}\n"""`;
    } else if (args) {
        textPrompt = args;
    } else {
        textPrompt = 'Hello! How can you help me today?';
    }

    contents.push(textPrompt);

    console.log(`[Gemini API] Sending prompt with Google Search enabled...`);
    const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: contents,
        
    });

    return { text: response.text || '🤖 Gemini generated an empty response.' };
}

// ==========================================
// 2. COMMAND REGISTRY
// ==========================================

const commands = {
    '!sharkny': async (args) => {
        if (!args) return { text: '⚠️ Usage: `!sharkny <game|tv|movie> <query>`' };
        const firstSpace = args.indexOf(' ');
        if (firstSpace === -1) return { text: '⚠️ Please include a search query.' };
        const type = args.slice(0, firstSpace).toLowerCase();
        const query = args.slice(firstSpace + 1).trim();

        if (type === 'game') return await searchIGDB(query);
        if (type === 'tv' || type === 'movie') return await searchTMDB(type, query);
        return { text: `❌ Unknown type "${type}". Use game, tv, or movie.` };
    },
    '!ai': handleAI,
    '!ping': async () => ({ text: 'Pong! 🏓' }),
};

// ==========================================
// 3. WHATSAPP SOCKET & ROUTER
// ==========================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Scan the QR code below to connect:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('✅ Bot successfully connected to WhatsApp!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message) continue;

            const jid = msg.key.remoteJid;
            const textBody = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ''
            ).trim();

            if (!textBody) continue;

            const spaceIndex = textBody.indexOf(' ');
            const trigger = (spaceIndex === -1 ? textBody : textBody.slice(0, spaceIndex)).toLowerCase();
            const args = spaceIndex === -1 ? '' : textBody.slice(spaceIndex + 1).trim();

            const handler = commands[trigger];
            if (!handler) continue;

            try {
                console.log(`[CMD] ${trigger} | From: ${jid}`);
                const result = await handler(args, msg, sock);
                
                if (result) {
                    if (typeof result === 'object' && result.image) {
                        await sock.sendMessage(jid, { 
                            image: result.image, 
                            caption: result.caption || result.text || '' 
                        }, { quoted: msg });
                    } else {
                        const textReply = typeof result === 'string' ? result : result.text;
                        await sock.sendMessage(jid, { text: textReply }, { quoted: msg });
                    }
                }
            } catch (error) {
                console.error(`Error executing ${trigger}:`, error);
                await sock.sendMessage(jid, { text: '❌ Something went wrong running that command.' }, { quoted: msg });
            }
        }
    });
}

connectToWhatsApp();