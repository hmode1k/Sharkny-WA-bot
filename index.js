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
// 1. SEARCH & RANKING HELPERS (IGDB, TMDB, GEMINI)
// ==========================================

// Extracts a trailing 4-digit year if present (e.g., "daredevil 2025" -> { cleanQuery: "daredevil", year: 2025 })
function parseQueryAndYear(rawQuery) {
    const match = rawQuery.match(/^(.*?)(?:\s+\(?((?:19|20)\d{2})\)?)$/);
    if (match && match[1].trim().length > 0) {
        return {
            cleanQuery: match[1].trim(),
            year: parseInt(match[2], 10)
        };
    }
    return { cleanQuery: rawQuery.trim(), year: null };
}

function normalizeTitle(str) {
    return (str || '')
        .toLowerCase()
        .replace(/[:\-–—'’.,!?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function searchIGDB(rawQuery) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const accessToken = process.env.IGDB_ACCESS_TOKEN;

    if (!clientId || !accessToken) {
        return { text: '⚠️ IGDB credentials are missing in your .env file.' };
    }

    try {
        const { cleanQuery, year } = parseQueryAndYear(rawQuery);
        const safeQuery = cleanQuery.replace(/"/g, '\\"');
        console.log(`[IGDB API] Querying games for: "${cleanQuery}"${year ? ` (Year: ${year})` : ''}`);

        const igdbRes = await fetch('https://api.igdb.com/v4/games', {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
            },
            body: `search "${safeQuery}"; fields name, summary, total_rating, total_rating_count, hypes, first_release_date, cover.image_id, platforms.name, game_type, category, id; where version_parent = null; limit 20;`
        });

        const rawData = await igdbRes.json();
        if (!Array.isArray(rawData) || rawData.length === 0) {
            return { text: `❌ No games found matching "${rawQuery}" on IGDB.` };
        }

        const normQuery = normalizeTitle(cleanQuery);

        // Score and rank candidates so main titles & popular games beat DLCs/fangames
        const ranked = rawData
            .map((g) => {
                const normName = normalizeTitle(g.name);
                const gameYear = g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null;
                const typeCode = g.game_type ?? g.category ?? 0;

                let score = 0;

                // 1. Title similarity
                if (normName === normQuery) score += 1000;
                else if (normName.startsWith(normQuery + ' ')) score += 450;
                else if (normName.includes(normQuery)) score += 200;

                // 2. Game type weight (0 = Main Game, 8 = Remake, 9 = Remaster)
                if (typeCode === 0) score += 300;
                else if (typeCode === 8 || typeCode === 9) score += 220;
                else if (typeCode === 4) score += 150; // Standalone expansion
                else score -= 150; // DLC, bundle, mod, episode

                // 3. Popularity & rating count
                const ratingCount = g.total_rating_count || 0;
                const hypes = g.hypes || 0;
                score += Math.min(ratingCount, 2000) * 0.6 + Math.min(hypes, 500) * 0.3;

                // 4. Optional year filter boost
                if (year && gameYear === year) score += 1500;

                return { ...g, _score: score, _year: gameYear };
            })
            .sort((a, b) => b._score - a._score);

        const game = ranked[0];
        const runnersUp = ranked
            .slice(1, 3)
            .map((g) => `${g.name}${g._year ? ` (${g._year})` : ''}`);

        const releaseYear = game._year || 'Unknown';
        const rating = game.total_rating ? Math.round(game.total_rating) + '/100' : 'N/A';
        const summary = game.summary ? game.summary.slice(0, 300) + '...' : 'No summary available.';
        const platformsList = game.platforms ? game.platforms.map(p => p.name).join(', ') : 'Not specified';

        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/game/${game.id}`;
        const alternativesFooter = runnersUp.length > 0 ? `\n\n🔎 *Other matches:* ${runnersUp.join(' • ')}` : '';
        const captionText = `🎮 *${game.name}* (${releaseYear})\n\n⭐ *Rating:* ${rating}\n\n🖥️ *Platforms:* ${platformsList}\n\n📝 *Overview:* ${summary}${sharknyLink}${alternativesFooter}`;

        const imageUrl = game.cover?.image_id
            ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${game.cover.image_id}.jpg`
            : null;

        return { image: imageUrl ? { url: imageUrl } : null, text: captionText };
    } catch (error) {
        console.error('IGDB Error:', error);
        return { text: '❌ Failed to fetch game from IGDB.' };
    }
}

async function searchTMDB(mediaType, rawQuery) {
    const tmdbToken = process.env.TMDB_ACCESS_TOKEN;
    if (!tmdbToken) {
        return { text: '⚠️ TMDB access token is missing in your .env file.' };
    }

    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const { cleanQuery, year } = parseQueryAndYear(rawQuery);
        console.log(`[TMDB API] Searching ${endpoint} for: "${cleanQuery}"${year ? ` (Year: ${year})` : ''}`);

        let searchUrl = `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(cleanQuery)}&include_adult=false&language=en-US&page=1`;
        if (year) {
            searchUrl += endpoint === 'tv' ? `&first_air_date_year=${year}` : `&primary_release_year=${year}`;
        }

        const searchRes = await fetch(searchUrl, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });

        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) {
            return { text: `❌ No results found matching "${rawQuery}" on TMDB.` };
        }

        const normQuery = normalizeTitle(cleanQuery);

        // Score top 15 results so exact title + established vote_count beats trending spin-offs
        const ranked = searchData.results
            .slice(0, 15)
            .map((entry) => {
                const entryTitle = entry.title || entry.name || '';
                const origTitle = entry.original_title || entry.original_name || '';
                const normTitle = normalizeTitle(entryTitle);
                const normOrig = normalizeTitle(origTitle);
                const rawDate = entry.release_date || entry.first_air_date;
                const entryYear = rawDate ? new Date(rawDate).getFullYear() : null;

                let score = 0;

                // 1. Exact vs prefix title match
                if (normTitle === normQuery || normOrig === normQuery) score += 1000;
                else if (normTitle.startsWith(normQuery + ' ')) score += 300;
                else if (normTitle.includes(normQuery)) score += 100;

                // 2. Vote count & popularity balance
                const voteCount = entry.vote_count || 0;
                const popularity = entry.popularity || 0;
                score += Math.min(voteCount, 10000) * 0.25 + Math.min(popularity, 500) * 0.5;

                // 3. Year match bonus
                if (year && entryYear === year) score += 1500;

                return { ...entry, _score: score, _year: entryYear };
            })
            .sort((a, b) => b._score - a._score);

        const bestMatch = ranked[0];
        const runnersUp = ranked
            .slice(1, 3)
            .map((r) => `${r.title || r.name}${r._year ? ` (${r._year})` : ''}`);

        const detailsRes = await fetch(`https://api.themoviedb.org/3/${endpoint}/${bestMatch.id}`, {
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
        const sharknyLink = `\n\n🔗 *View on Sharkny:* https://sharkny-three.vercel.app/${endpoint}/${item.id}`;
        const alternativesFooter = runnersUp.length > 0 ? `\n\n🔎 *Other matches:* ${runnersUp.join(' • ')}` : '';
        const captionText = `${typeEmoji} *${title}* (${releaseYear})\n\n⭐ *Rating:* ${rating}${extraStats}\n\n📝 *Overview:* ${overview}${sharknyLink}${alternativesFooter}`;

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
                throw error;
            }
        }

        const errCode = lastError?.status || 'Unknown';
        return { text: `❌ All AI models are currently busy or out of quota (Error: ${errCode}). Try again in a minute.` };
    } finally {
        await sock.sendPresenceUpdate('paused', jid);
    }
}

// ==========================================
// 2. FREE GAMES FETCHER & DEALS MONITOR
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

async function fetchActiveDeals() {
    let dealsList = [];

    // --- A. FETCH STEAM FREE SPECIALS ---
    try {
        const steamUrl = 'https://store.steampowered.com/search/results/?query&start=0&count=15&maxprice=free&category1=998&specials=1&json=1';
        const steamRes = await fetch(steamUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const steamData = await steamRes.json();

        if (steamData?.results?.length > 0) {
            for (const item of steamData.results) {
                if (item.price?.discount_percent === 100) {
                    dealsList.push({
                        id: `steam_${item.id}`,
                        title: item.name,
                        store: 'Steam',
                        originalPrice: item.price?.original_formatted || 'Paid',
                        link: item.url,
                        image: item.logo || null
                    });
                }
            }
        }
    } catch (error) {
        console.error('[Deals Fetcher] Error fetching Steam deals:', error);
    }

    // --- B. FETCH EPIC GAMES STORE FREEBIES ---
    try {
        const epicUrl = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US';
        const epicRes = await fetch(epicUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const epicData = await epicRes.json();
        const elements = epicData?.data?.Catalog?.searchStore?.elements || [];

        for (const game of elements) {
            const activeOffers = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
            const isFreeNow = activeOffers.some(
                offer => offer.discountSetting?.discountType === 'PERCENTAGE' && offer.discountSetting?.discountPercentage === 0
            );

            if (isFreeNow) {
                const slug = game.catalogNs?.mappings?.[0]?.pageSlug || game.productSlug || game.urlSlug;
                const storeLink = slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games';
                const originalPrice = game.price?.totalPrice?.fmtPrice?.originalPrice || 'Paid';
                const imageObj =
                    game.keyImages?.find(img => img.type === 'OfferImageWide') ||
                    game.keyImages?.find(img => img.type === 'DieselStoreFrontWide') ||
                    game.keyImages?.[0];

                dealsList.push({
                    id: `epic_${game.id}`,
                    title: game.title,
                    store: 'Epic Games Store',
                    originalPrice: originalPrice,
                    link: storeLink,
                    image: imageObj?.url || null
                });
            }
        }
    } catch (error) {
        console.error('[Deals Fetcher] Error fetching Epic Games deals:', error);
    }

    return dealsList;
}

async function checkFreeGames(sock) {
    const targetJid = process.env.ALERT_TARGET_JID;
    if (!targetJid) return;

    const sentDeals = getSentDeals();
    const activeDeals = await fetchActiveDeals();

    for (const deal of activeDeals) {
        if (!sentDeals.includes(deal.id)) {
            console.log(`[Deals Monitor] New freebie found: ${deal.title} (${deal.store})`);
            const messageText = `🚨 *FREE ${deal.store.toUpperCase()} ALERT!* 🚨\n\n🎮 *${deal.title}*\n🏷️ *Normal Price:* ~${deal.originalPrice}~\n💸 *Now:* *100% FREE!*\n\n🔗 *Store Link:* ${deal.link}`;

            if (deal.image) {
                await sock.sendMessage(targetJid, { image: { url: deal.image }, caption: messageText });
            } else {
                await sock.sendMessage(targetJid, { text: messageText });
            }

            saveSentDeal(deal.id);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

function startDealsMonitor(sock) {
    checkFreeGames(sock);
    const intervalHours = 3;
    setInterval(() => {
        checkFreeGames(sock);
    }, intervalHours * 60 * 60 * 1000);
    console.log(`[Deals Monitor] Steam & Epic Games background checker active.`);
}

// ==========================================
// 3. COMMAND REGISTRY & CONSOLE SENDER
// ==========================================

const commands = {
    '!sharkny': async (args) => {
        if (!args) return { text: '⚠️ Usage: `!sharkny <game|tv|movie> <query> [year]`' };
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
    '!deals': async (args, msg, sock) => {
        const jid = msg.key.remoteJid;
        await sock.sendMessage(jid, { text: '🔍 Scanning Steam and Epic Games for currently active 100% free deals...' });

        const deals = await fetchActiveDeals();

        if (deals.length === 0) {
            return { text: 'ℹ️ There are currently no active 100% free game promotions running on Steam or Epic Games.' };
        }

        await sock.sendMessage(jid, { text: `🎯 Found *${deals.length}* active free game deal(s) right now:` });

        for (const deal of deals) {
            const cardText = `🎮 *${deal.title}* (${deal.store})\n🏷️ *Normal Price:* ~${deal.originalPrice}~\n💸 *Price:* *100% FREE*\n\n🔗 *Store Link:* ${deal.link}`;

            if (deal.image) {
                await sock.sendMessage(jid, { image: { url: deal.image }, caption: cardText });
            } else {
                await sock.sendMessage(jid, { text: cardText });
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }
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