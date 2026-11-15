import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { GoogleGenAI } from '@google/genai';

// Initialize Gemini client (automatically reads process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({});

// Ordered fallback list for Gemini models (handles 429 quota limits & 503 busy errors)
const AI_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash'
];

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
        if (!rawData || rawData.length === 0) {
            return { text: `❌ No games found matching "${query}" on IGDB.` };
        }

        const game = rawData[0];
        const releaseYear = game.first_release_date ? new Date(game.first_release_date * 1000).getFullYear() : 'Unknown';
        const rating = game.total_rating ? Math.round(game.total_rating) + '/100' : 'N/A';
        const summary = game.summary ? game.summary.slice(0, 300) + '...' : 'No summary available.';
        const platformsList = game.platforms ? game.platforms.map(p => p.name).join(', ') : 'Not specified';

        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/game/${game.id}`;
        const captionText = `🎮 *${game.name}* (${releaseYear})\n\n⭐ *Rating:* ${rating}\n\n🖥️ *Platforms:* ${platformsList}\n\n📝 *Overview:* ${summary}${sharknyLink}`;

        const imageUrl = game.cover?.image_id
            ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
            : null;

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
        console.log(`[TMDB API] Searching ${endpoint} for: "${query}"`);

        const searchRes = await fetch(`https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(query)}`, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });

        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) {
            return { text: `❌ No results found matching "${query}" on TMDB.` };
        }

        const itemId = searchData.results[0].id;
        const detailsRes = await fetch(`https://api.themoviedb.org/3/${endpoint}/${itemId}`, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });

        const item = await detailsRes.json();
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
        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/tv/${item.id}`;
        const captionText = `${typeEmoji} *${title}* (${releaseYear})\n\n⭐ *Rating:* ${rating}${extraStats}\n\n📝 *Overview:* ${overview}${sharknyLink}`;

        const imageUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

        return { image: imageUrl ? { url: imageUrl } : null, text: captionText };
    } catch (error) {
        console.error('TMDB Error:', error);
        return { text: '❌ Failed to fetch media details from TMDB.' };
    }
}

async function handleAI(args, msg, sock) {
    const jid = msg.key.remoteJid;
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
                console.log('[Gemini API] Downloading quoted image...');
                quotedImageBuffer = await downloadMediaMessage(
                    { message: quotedMessage },
                    'buffer',
                    {},
                    { logger: pino({ level: 'silent' }) }
                );
            } catch (err) {
                console.error('Failed to download image from quoted message:', err);
            }
        }
    }

    const contents = [];

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
        return { text: '⚠️ Please provide a prompt or reply to a message with `!ai`.' };
    }

    contents.push(textPrompt);

    // Show "typing..." status in WhatsApp chat
    await sock.sendPresenceUpdate('composing', jid);

    let lastError = null;

    try {
        for (const modelName of AI_MODELS) {
            try {
                console.log(`[Gemini API] Trying model: ${modelName}`);
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: contents,
                });

                return { text: response.text || '🤖 Gemini generated an empty response.' };
            } catch (error) {
                lastError = error;
                const status = error?.status || '';
                const msgText = error?.message || '';
                const isRetryable =
                    status === 429 ||
                    status === 503 ||
                    msgText.includes('429') ||
                    msgText.includes('503') ||
                    msgText.toLowerCase().includes('quota') ||
                    msgText.toLowerCase().includes('overloaded');

                if (isRetryable) {
                    console.warn(`[Gemini API] ${modelName} hit limit/busy (${status}). Switching to next model...`);
                    continue;
                }
                throw error; // Non-quota error (e.g., invalid API key), stop retrying
            }
        }

        // If all models in the array failed
        const errCode = lastError?.status || 'Unknown';
        return { text: `❌ All AI models are currently busy or out of quota (Error: ${errCode}). Try again in a minute.` };
    } finally {
        // Clear typing indicator once finished or errored
        await sock.sendPresenceUpdate('paused', jid);
    }
}

// ==========================================
// 2. UNIFIED FREE GAMES MONITOR (STEAM & EPIC)
// ==========================================

const SENT_DEALS_FILE = './sent_deals.json';

function getSentDeals() {
    try {
        if (fs.existsSync(SENT_DEALS_FILE)) {
            return JSON.parse(fs.readFileSync(SENT_DEALS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading sent_deals.json:', e);
    }
    return [];
}

function saveSentDeal(dealKey) {
    const deals = getSentDeals();
    if (!deals.includes(dealKey)) {
        deals.push(dealKey);
        fs.writeFileSync(SENT_DEALS_FILE, JSON.stringify(deals, null, 2));
    }
}

async function checkFreeGames(sock) {
    const targetJid = process.env.ALERT_TARGET_JID;
    if (!targetJid) {
        console.log('[Deals Monitor] ALERT_TARGET_JID not set in .env. Skipping check.');
        return;
    }

    const sentDeals = getSentDeals();

    // --- A. CHECK STEAM 100% OFF SPECIALS ---
    try {
        console.log('[Deals Monitor] Checking Steam for 100% free game promotions...');
        const steamUrl = 'https://store.steampowered.com/search/results/?query&start=0&count=15&maxprice=free&category1=998&specials=1&json=1';
        const steamRes = await fetch(steamUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const steamData = await steamRes.json();
        if (steamData?.results?.length > 0) {
            for (const item of steamData.results) {
                const dealKey = `steam_${item.id}`;
                const isDiscounted = item.price?.discount_percent === 100;

                if (isDiscounted && !sentDeals.includes(dealKey)) {
                    console.log(`[Deals Monitor] New Steam freebie: ${item.name}`);
                    const originalPrice = item.price?.original_formatted || 'Paid';
                    const messageText = `🚨 *FREE STEAM GAME ALERT!* 🚨\n\n🎮 *${item.name}*\n🏷️ *Normal Price:* ~${originalPrice}~\n💸 *Now:* *100% FREE!*\n\n🔗 *Store Link:* ${item.url}`;

                    if (item.logo) {
                        await sock.sendMessage(targetJid, { image: { url: item.logo }, caption: messageText });
                    } else {
                        await sock.sendMessage(targetJid, { text: messageText });
                    }

                    saveSentDeal(dealKey);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
    } catch (error) {
        console.error('[Deals Monitor] Error checking Steam deals:', error);
    }

    // --- B. CHECK EPIC GAMES STORE FREE PROMOTIONS ---
    try {
        console.log('[Deals Monitor] Checking Epic Games Store for free games...');
        const epicUrl = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
        const epicRes = await fetch(epicUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const epicData = await epicRes.json();
        const elements = epicData?.data?.Catalog?.searchStore?.elements || [];

        for (const game of elements) {
            // Check if there is an active promotional offer with 0% price (100% off)
            const activeOffers = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
            const isFreeNow = activeOffers.some(
                offer => offer.discountSetting?.discountType === 'PERCENTAGE' && offer.discountSetting?.discountPercentage === 0
            );

            const dealKey = `epic_${game.id}`;

            if (isFreeNow && !sentDeals.includes(dealKey)) {
                console.log(`[Deals Monitor] New Epic Games freebie: ${game.title}`);

                const slug = game.catalogNs?.mappings?.[0]?.pageSlug || game.productSlug || game.urlSlug;
                const storeLink = slug
                    ? `https://store.epicgames.com/en-US/p/${slug}`
                    : 'https://store.epicgames.com/en-US/free-games';

                const originalPrice = game.price?.totalPrice?.fmtPrice?.originalPrice || 'Paid';
                const endDateRaw = activeOffers[0]?.endDate;
                const endDateText = endDateRaw ? new Date(endDateRaw).toUTCString() : 'Limited Time';

                // Grab cover/wide promotional image
                const imageObj =
                    game.keyImages?.find(img => img.type === 'OfferImageWide') ||
                    game.keyImages?.find(img => img.type === 'DieselStoreFrontWide') ||
                    game.keyImages?.[0];

                const messageText = `🚨 *FREE EPIC GAMES ALERT!* 🚨\n\n🎮 *${game.title}*\n🏷️ *Normal Price:* ~${originalPrice}~\n💸 *Now:* *100% FREE!*\n⏳ *Ends:* ${endDateText}\n\n🔗 *Claim Here:* ${storeLink}`;

                if (imageObj?.url) {
                    await sock.sendMessage(targetJid, { image: { url: imageObj.url }, caption: messageText });
                } else {
                    await sock.sendMessage(targetJid, { text: messageText });
                }

                saveSentDeal(dealKey);
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    } catch (error) {
        console.error('[Deals Monitor] Error checking Epic Games deals:', error);
    }
}

function startDealsMonitor(sock) {
    checkFreeGames(sock);

    const intervalHours = 3;
    setInterval(() => {
        checkFreeGames(sock);
    }, intervalHours * 60 * 60 * 1000);

    console.log(`[Deals Monitor] Steam & Epic Games checker active (every ${intervalHours} hours).`);
}

// ==========================================
// 3. COMMAND REGISTRY & CONSOLE SENDER
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
        return { text: `❌ Unknown type "${type}". Use \`game\`, \`tv\`, or \`movie\`.` };
    },
    '!ai': handleAI,
    '!ping': async () => ({ text: 'Pong! 🏓' }),
};

function setupConsoleSender(sock) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('\n💬 [Console Chat Ready] Type: send <number> <message>\n');

    rl.on('line', async (line) => {
        const parts = line.trim().split(' ');
        const action = parts[0]?.toLowerCase();
        const target = parts[1];
        const messageText = parts.slice(2).join(' ');

        if (action === 'send' && target && messageText) {
            const cleanNumber = target.replace(/[^0-9]/g, '');
            const jid = `${cleanNumber}@s.whatsapp.net`;

            try {
                await sock.sendMessage(jid, { text: messageText });
                console.log(`✅ [Console] Sent message to ${jid}`);
            } catch (error) {
                console.error(`❌ [Console] Failed to send to ${jid}:`, error);
            }
        } else if (line.trim()) {
            console.log('⚠️ Invalid format. Use: send <number> <message>');
        }
    });
}

// ==========================================
// 4. WHATSAPP SOCKET & ROUTER
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
            setupConsoleSender(sock);
            startDealsMonitor(sock);
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