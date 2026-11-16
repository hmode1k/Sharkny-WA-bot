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

function rankIGDBResults(rawData, cleanQuery, year = null) {
    const normQuery = normalizeTitle(cleanQuery);

    return rawData
        .map((g) => {
            const normName = normalizeTitle(g.name);
            const gameYear = g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : null;
            const typeCode = g.game_type ?? g.category ?? 0;

            let score = 0;
            if (normName === normQuery) score += 1000;
            else if (normName.startsWith(normQuery + ' ')) score += 450;
            else if (normName.includes(normQuery)) score += 200;

            if (typeCode === 0) score += 300;
            else if (typeCode === 8 || typeCode === 9) score += 220;
            else if (typeCode === 4) score += 150;
            else score -= 150;

            const ratingCount = g.total_rating_count || 0;
            const hypes = g.hypes || 0;
            score += Math.min(ratingCount, 2000) * 0.6 + Math.min(hypes, 500) * 0.3;

            if (year && gameYear === year) score += 1500;

            return { ...g, _score: score, _year: gameYear };
        })
        .sort((a, b) => b._score - a._score);
}

function rankTMDBResults(results, cleanQuery, year = null) {
    const normQuery = normalizeTitle(cleanQuery);

    return results
        .map((entry) => {
            const entryTitle = entry.title || entry.name || '';
            const origTitle = entry.original_title || entry.original_name || '';
            const normTitle = normalizeTitle(entryTitle);
            const normOrig = normalizeTitle(origTitle);
            const rawDate = entry.release_date || entry.first_air_date;
            const entryYear = rawDate ? new Date(rawDate).getFullYear() : null;

            let score = 0;
            if (normTitle === normQuery || normOrig === normQuery) score += 1000;
            else if (normTitle.startsWith(normQuery + ' ')) score += 300;
            else if (normTitle.includes(normQuery)) score += 100;

            const voteCount = entry.vote_count || 0;
            const popularity = entry.popularity || 0;
            score += Math.min(voteCount, 10000) * 0.25 + Math.min(popularity, 500) * 0.5;

            if (year && entryYear === year) score += 1500;

            return { ...entry, _score: score, _year: entryYear };
        })
        .sort((a, b) => b._score - a._score);
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

        const ranked = rankIGDBResults(rawData, cleanQuery, year);
        const game = ranked[0];
        const runnersUp = ranked.slice(1, 3).map((g) => `${g.name}${g._year ? ` (${g._year})` : ''}`);

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

async function listIGDBGames(subArg) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const accessToken = process.env.IGDB_ACCESS_TOKEN;

    if (!clientId || !accessToken) {
        return { text: '⚠️ IGDB credentials are missing in your .env file.' };
    }

    if (!subArg) {
        return { text: '⚠️ Usage:\n• `!sharkny list game popular [page]`\n• `!sharkny list game new [page]`\n• `!sharkny list game <query> [1-10]`' };
    }

    const parts = subArg.trim().split(/\s+/);
    const firstToken = parts[0].toLowerCase();

    let mode = 'search';
    let page = 1;
    let count = 5;
    let queryTerm = '';

    if (firstToken === 'popular' || firstToken === 'new') {
        mode = firstToken;
        count = 10;
        if (parts[1] && /^\d+$/.test(parts[1])) {
            page = Math.max(1, parseInt(parts[1], 10));
        }
    } else {
        const lastToken = parts[parts.length - 1];
        if (parts.length > 1 && /^\d+$/.test(lastToken)) {
            count = Math.min(10, Math.max(1, parseInt(lastToken, 10)));
            queryTerm = parts.slice(0, -1).join(' ');
        } else {
            queryTerm = subArg.trim();
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const thirtyDaysAgoSec = nowSec - 30 * 24 * 60 * 60;
    const offset = (page - 1) * count;
    let body = '';

    if (mode === 'popular') {
        body = `fields name, total_rating, total_rating_count, hypes, first_release_date, id; where version_parent = null & cover != null & first_release_date >= ${thirtyDaysAgoSec} & first_release_date <= ${nowSec}; sort hypes desc; limit ${count}; offset ${offset};`;
    } else if (mode === 'new') {
        body = `fields name, total_rating, first_release_date, id; where version_parent = null & cover != null & first_release_date >= ${thirtyDaysAgoSec} & first_release_date <= ${nowSec}; sort first_release_date desc; limit ${count}; offset ${offset};`;
    } else {
        const safeQuery = queryTerm.replace(/"/g, '\\"');
        body = `search "${safeQuery}"; fields name, total_rating, total_rating_count, hypes, first_release_date, game_type, category, id; where version_parent = null; limit 20;`;
    }

    try {
        const igdbRes = await fetch('https://api.igdb.com/v4/games', {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
            },
            body
        });

        const rawData = await igdbRes.json();
        if (!Array.isArray(rawData) || rawData.length === 0) {
            return { text: `❌ No games found for \`!sharkny list game ${subArg}\`.` };
        }

        const results = mode === 'search' ? rankIGDBResults(rawData, queryTerm).slice(0, count) : rawData;

        let header = '';
        if (mode === 'popular') header = `🔥 *Popular Games (Last 30 Days — Page ${page})*\n\n`;
        else if (mode === 'new') header = `🆕 *Newest Releases (Last 30 Days — Page ${page})*\n\n`;
        else header = `🎮 *Top ${results.length} Game Results for "${queryTerm}"*\n\n`;

        const lines = results.map((g, idx) => {
            const rankNum = mode === 'search' ? idx + 1 : offset + idx + 1;
            const dateStr = g.first_release_date ? new Date(g.first_release_date * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBA';
            const ratingStr = g.total_rating ? ` | ⭐ ${Math.round(g.total_rating)}/100` : '';
            return `*${rankNum}. ${g.name}* (${dateStr}${ratingStr})\n🔗 https://sharkny-three.vercel.app/game/${g.id}`;
        });

        const footer = (mode === 'popular' || mode === 'new') ? `\n\n📄 _Next page:_ \`!sharkny list game ${mode} ${page + 1}\`` : '';
        return { text: header + lines.join('\n\n') + footer };
    } catch (error) {
        console.error('IGDB List Error:', error);
        return { text: '❌ Failed to fetch game list from IGDB.' };
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

        const ranked = rankTMDBResults(searchData.results, cleanQuery, year);
        const bestMatch = ranked[0];
        const runnersUp = ranked.slice(1, 3).map((r) => `${r.title || r.name}${r._year ? ` (${r._year})` : ''}`);

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

async function listTMDBMedia(mediaType, subArg) {
    const tmdbToken = process.env.TMDB_ACCESS_TOKEN;
    if (!tmdbToken) {
        return { text: '⚠️ TMDB access token is missing in your .env file.' };
    }

    if (!subArg) {
        return { text: `⚠️ Usage:\n• \`!sharkny list ${mediaType} popular [page]\`\n• \`!sharkny list ${mediaType} new [page]\`\n• \`!sharkny list ${mediaType} <query> [1-10]\`` };
    }

    const parts = subArg.trim().split(/\s+/);
    const firstToken = parts[0].toLowerCase();

    let mode = 'search';
    let page = 1;
    let count = 5;
    let queryTerm = '';

    if (firstToken === 'popular' || firstToken === 'new') {
        mode = firstToken;
        count = 10;
        if (parts[1] && /^\d+$/.test(parts[1])) {
            page = Math.max(1, parseInt(parts[1], 10));
        }
    } else {
        const lastToken = parts[parts.length - 1];
        if (parts.length > 1 && /^\d+$/.test(lastToken)) {
            count = Math.min(10, Math.max(1, parseInt(lastToken, 10)));
            queryTerm = parts.slice(0, -1).join(' ');
        } else {
            queryTerm = subArg.trim();
        }
    }

    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    let fetchUrl = '';

    if (mode === 'popular') {
        fetchUrl = `https://api.themoviedb.org/3/${endpoint}/popular?language=en-US&page=${page}`;
    } else if (mode === 'new') {
        fetchUrl = mediaType === 'tv'
            ? `https://api.themoviedb.org/3/tv/on_the_air?language=en-US&page=${page}`
            : `https://api.themoviedb.org/3/movie/now_playing?language=en-US&page=${page}`;
    } else {
        fetchUrl = `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(queryTerm)}&include_adult=false&language=en-US&page=1`;
    }

    try {
        const res = await fetch(fetchUrl, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (!data.results || data.results.length === 0) {
            return { text: `❌ No results found for \`!sharkny list ${mediaType} ${subArg}\`.` };
        }

        const results = mode === 'search'
            ? rankTMDBResults(data.results, queryTerm).slice(0, count)
            : data.results.slice(0, count);

        const typeTitle = mediaType === 'tv' ? 'TV Shows' : 'Movies';
        let header = '';
        if (mode === 'popular') header = `🔥 *Popular ${typeTitle} (Page ${page})*\n\n`;
        else if (mode === 'new') header = `🆕 *New / Airing ${typeTitle} (Page ${page})*\n\n`;
        else header = `🎬 *Top ${results.length} ${typeTitle} for "${queryTerm}"*\n\n`;

        const lines = results.map((item, idx) => {
            const rankNum = mode === 'search' ? idx + 1 : ((page - 1) * count) + idx + 1;
            const title = item.title || item.name || 'Unknown';
            const rawDate = item.release_date || item.first_air_date;
            const year = rawDate ? new Date(rawDate).getFullYear() : 'N/A';
            const rating = item.vote_average ? ` | ⭐ ${item.vote_average.toFixed(1)}/10` : '';
            return `*${rankNum}. ${title}* (${year}${rating})\n🔗 https://sharkny-three.vercel.app/${endpoint}/${item.id}`;
        });

        const footer = (mode === 'popular' || mode === 'new') ? `\n\n📄 _Next page:_ \`!sharkny list ${mediaType} ${mode} ${page + 1}\`` : '';
        return { text: header + lines.join('\n\n') + footer };
    } catch (error) {
        console.error('TMDB List Error:', error);
        return { text: `❌ Failed to fetch ${mediaType} list from TMDB.` };
    }
}

async function handleAI(args, msg, sock) {
    const jid = msg.key.remoteJid;
    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const quotedMessage = contextInfo?.quotedMessage;

    let quotedText = '';
    let quotedImageBuffer = null;

    if (quotedMessage) {
        quotedText = quotedMessage.conversation || quotedMessage.extendedTextMessage?.text || quotedMessage.imageMessage?.caption || '';
        if (quotedMessage.imageMessage) {
            try {
                quotedImageBuffer = await downloadMediaMessage({ message: quotedMessage }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
            } catch (err) {
                console.error('Failed to download image:', err);
            }
        }
    }

    const contents = [];
    if (quotedImageBuffer) {
        contents.push({ inlineData: { data: quotedImageBuffer.toString('base64'), mimeType: 'image/jpeg' } });
    }

    let textPrompt = '';
    if (quotedText && args) textPrompt = `${args}\n\nContext:\n"""\n${quotedText}\n"""`;
    else if (quotedText && !args) textPrompt = `Analyze or respond to this message/content:\n"""\n${quotedText}\n"""`;
    else if (args) textPrompt = args;
    else return { text: '⚠️ Please provide a prompt or reply to a message with `!ai`.' };

    contents.push(textPrompt);
    await sock.sendPresenceUpdate('composing', jid);

    let lastError = null;
    try {
        for (const modelName of AI_MODELS) {
            try {
                const response = await ai.models.generateContent({ model: modelName, contents: contents });
                return { text: response.text || '🤖 Gemini generated an empty response.' };
            } catch (error) {
                lastError = error;
                const status = error?.status || '';
                const msgText = error?.message || '';
                if (status === 429 || status === 503 || msgText.includes('429') || msgText.includes('503')) continue;
                throw error;
            }
        }
        return { text: `❌ All AI models are currently busy or out of quota. Try again in a minute.` };
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
        if (fs.existsSync(SENT_DEALS_FILE)) return JSON.parse(fs.readFileSync(SENT_DEALS_FILE, 'utf8'));
    } catch (e) {}
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
    try {
        const steamRes = await fetch('https://store.steampowered.com/search/results/?query&start=0&count=15&maxprice=free&category1=998&specials=1&json=1', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const steamData = await steamRes.json();
        if (steamData?.results) {
            for (const item of steamData.results) {
                if (item.price?.discount_percent === 100) {
                    dealsList.push({ id: `steam_${item.id}`, title: item.name, store: 'Steam', originalPrice: item.price?.original_formatted || 'Paid', link: item.url, image: item.logo || null });
                }
            }
        }
    } catch (e) {}

    try {
        const epicRes = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const epicData = await epicRes.json();
        const elements = epicData?.data?.Catalog?.searchStore?.elements || [];
        for (const game of elements) {
            const activeOffers = game.promotions?.promotionalOffers?.[0]?.promotionalOffers || [];
            const isFreeNow = activeOffers.some(o => o.discountSetting?.discountPercentage === 0);
            if (isFreeNow) {
                const slug = game.catalogNs?.mappings?.[0]?.pageSlug || game.productSlug || game.urlSlug;
                const storeLink = slug ? `https://store.epicgames.com/en-US/p/${slug}` : 'https://store.epicgames.com/en-US/free-games';
                const imageObj = game.keyImages?.find(img => img.type === 'OfferImageWide') || game.keyImages?.[0];
                dealsList.push({ id: `epic_${game.id}`, title: game.title, store: 'Epic Games Store', originalPrice: game.price?.totalPrice?.fmtPrice?.originalPrice || 'Paid', link: storeLink, image: imageObj?.url || null });
            }
        }
    } catch (e) {}

    return dealsList;
}

async function checkFreeGames(sock) {
    const targetJid = process.env.ALERT_TARGET_JID;
    if (!targetJid) return;
    const sentDeals = getSentDeals();
    const activeDeals = await fetchActiveDeals();

    for (const deal of activeDeals) {
        if (!sentDeals.includes(deal.id)) {
            const messageText = `🚨 *FREE ${deal.store.toUpperCase()} ALERT!* 🚨\n\n🎮 *${deal.title}*\n🏷️ *Normal Price:* ~${deal.originalPrice}~\n💸 *Now:* *100% FREE!*\n\n🔗 *Store Link:* ${deal.link}`;
            if (deal.image) {
                await sock.sendMessage(targetJid, { image: { url: deal.image }, caption: messageText });
            } else {
                await sock.sendMessage(targetJid, { text: messageText });
            }
            saveSentDeal(deal.id);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

function startDealsMonitor(sock) {
    checkFreeGames(sock);
    setInterval(() => checkFreeGames(sock), 3 * 60 * 60 * 1000);
}

// ==========================================
// 3. COMMAND REGISTRY & CONSOLE SENDER
// ==========================================

const commands = {
    '!help': async (args) => {
        const query = (args || '').trim().toLowerCase();

        if (query === 'sharkny') {
            return {
                text: `🦈 *Sharkny Comprehensive Guide* 🦈\n\n` +
                      `**1. Single Lookups (with optional year parsing):**\n` +
                      `• \`!sharkny game <title> [year]\`\n` +
                      `  _Example:_ \`!sharkny game god of war 2005\`\n` +
                      `• \`!sharkny movie <title> [year]\`\n` +
                      `  _Example:_ \`!sharkny movie dune 2021\`\n` +
                      `• \`!sharkny tv <title> [year]\`\n` +
                      `  _Example:_ \`!sharkny tv daredevil 2015\`\n\n` +
                      `**2. Lists & Pagination:**\n` +
                      `• \`!sharkny list <game|movie|tv> popular [page]\`\n` +
                      `  _Example:_ \`!sharkny list game popular 2\`\n` +
                      `• \`!sharkny list <game|movie|tv> new [page]\`\n` +
                      `  _Example:_ \`!sharkny list tv new\`\n` +
                      `• \`!sharkny list <game|movie|tv> <query> [count]\`\n` +
                      `  _Example:_ \`!sharkny list movie batman 8\`\n\n` +
                      `🔗 *Main Platform:* https://sharkny-three.vercel.app`
            };
        }

        return {
            text: `🤖 *Sharkny Bot Command Center* 🤖\n\n` +
                  `• \`!sharkny ...\` — Search games, movies, TV shows, or browse lists.\n` +
                  `• \`!ai <prompt>\` — Chat with Gemini (supports replying to images & text context, with auto model failover).\n` +
                  `• \`!deals\` — View all currently active 100% free games on Steam & Epic Games.\n` +
                  `• \`!ping\` — Test bot response time.\n` +
                  `• \`!help sharkny\` — Detailed documentation for Sharkny search & list features.\n\n` +
                  `💡 _Tip: You can also quote any image or message when using \`!ai\` for analysis!_`
        };
    },
    '!sharkny': async (args) => {
        if (!args) {
            return {
                text: '⚠️ Usage:\n• `!sharkny <game|tv|movie> <query> [year]`\n• `!sharkny list <game|tv|movie> <popular|new|query> [page/count]`\n• Type `!help sharkny` for full documentation.'
            };
        }

        const firstSpace = args.indexOf(' ');
        if (firstSpace === -1) return { text: '⚠️ Please include a search query or subcommand. Type `!help sharkny` for details.' };

        const subCmd = args.slice(0, firstSpace).toLowerCase();
        const rest = args.slice(firstSpace + 1).trim();

        if (subCmd === 'list') {
            const secondSpace = rest.indexOf(' ');
            const listType = (secondSpace === -1 ? rest : rest.slice(0, secondSpace)).toLowerCase();
            const listArgs = secondSpace === -1 ? '' : rest.slice(secondSpace + 1).trim();

            if (listType === 'game') return await listIGDBGames(listArgs);
            if (listType === 'movie' || listType === 'tv') return await listTMDBMedia(listType, listArgs);
            return { text: `❌ Unknown list type "${listType}". Use \`game\`, \`movie\`, or \`tv\`.` };
        }

        if (subCmd === 'game') return await searchIGDB(rest);
        if (subCmd === 'tv' || subCmd === 'movie') return await searchTMDB(subCmd, rest);
        return { text: `❌ Unknown type "${subCmd}". Use \`game\`, \`tv\`, \`movie\`, or \`list <type>\`. Type \`!help\` for commands.` };
    },
    '!ai': handleAI,
    '!ping': async () => ({ text: 'Pong! 🏓' }),
    '!deals': async (args, msg, sock) => {
        const jid = msg.key.remoteJid;
        await sock.sendMessage(jid, { text: '🔍 Scanning Steam and Epic Games for currently active 100% free deals...' });
        const deals = await fetchActiveDeals();
        if (deals.length === 0) return { text: 'ℹ️ There are currently no active 100% free game promotions running.' };

        await sock.sendMessage(jid, { text: `🎯 Found *${deals.length}* active free game deal(s) right now:` });
        for (const deal of deals) {
            const cardText = `🎮 *${deal.title}* (${deal.store})\n🏷️ *Normal Price:* ~${deal.originalPrice}~\n💸 *Price:* *100% FREE*\n\n🔗 *Store Link:* ${deal.link}`;
            if (deal.image) {
                await sock.sendMessage(jid, { image: { url: deal.image }, caption: cardText });
            } else {
                await sock.sendMessage(jid, { text: cardText });
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }
};

function setupConsoleSender(sock) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
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
        }
    });
}

// ==========================================
// 4. WHATSAPP SOCKET & ROUTER
// ==========================================

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }) });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Scan the QR code below to connect:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) connectToWhatsApp();
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
            const textBody = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
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
                        await sock.sendMessage(jid, { image: result.image, caption: result.caption || result.text || '' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(jid, { text: typeof result === 'string' ? result : result.text }, { quoted: msg });
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