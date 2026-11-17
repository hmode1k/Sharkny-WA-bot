import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { GoogleGenAI } from '@google/genai';

// Initialize Gemini client (automatically reads process.env.GEMINI_API_KEY)
const ai = new GoogleGenAI({});

const USER_AGENT = 'Sharkny/1.0';

// Ordered fallback list for Gemini models (handles 429 quota limits & 503 busy errors)
const AI_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash'
];

// Helper for human-like anti-spam delays (random jitter between minMs and maxMs)
function sleepJitter(minMs, maxMs) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return new Promise(resolve => setTimeout(resolve, delay));
}

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
                'User-Agent': USER_AGENT
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

async function listIGDBGames(subArg, sock, jid) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const accessToken = process.env.IGDB_ACCESS_TOKEN;

    if (!clientId || !accessToken) {
        await sock.sendMessage(jid, { text: '⚠️ IGDB credentials are missing in your .env file.' });
        return;
    }

    if (!subArg) {
        await sock.sendMessage(jid, { text: '⚠️ Usage:\n• `!sharkny list game popular [page]`\n• `!sharkny list game new [page]`\n• `!sharkny list game <query> [page]`' });
        return;
    }

    const parts = subArg.trim().split(/\s+/);
    const firstToken = parts[0].toLowerCase();

    let mode = 'search';
    let page = 1;
    let queryTerm = '';
    const pageSize = 5;

    if (firstToken === 'popular' || firstToken === 'new') {
        mode = firstToken;
        if (parts[1] && /^\d+$/.test(parts[1])) {
            page = Math.max(1, parseInt(parts[1], 10));
        }
    } else {
        const lastToken = parts[parts.length - 1];
        if (parts.length > 1 && /^\d+$/.test(lastToken)) {
            page = Math.max(1, parseInt(lastToken, 10));
            queryTerm = parts.slice(0, -1).join(' ');
        } else {
            queryTerm = subArg.trim();
        }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const thirtyDaysAgoSec = nowSec - 30 * 24 * 60 * 60;
    const offset = (page - 1) * pageSize;
    let body = '';

    if (mode === 'popular') {
        body = `fields name, total_rating, total_rating_count, hypes, first_release_date, cover.image_id, id; where version_parent = null & cover != null & first_release_date >= ${thirtyDaysAgoSec} & first_release_date <= ${nowSec}; sort hypes desc; limit ${pageSize}; offset ${offset};`;
    } else if (mode === 'new') {
        body = `fields name, total_rating, first_release_date, cover.image_id, id; where version_parent = null & cover != null & first_release_date >= ${thirtyDaysAgoSec} & first_release_date <= ${nowSec}; sort first_release_date desc; limit ${pageSize}; offset ${offset};`;
    } else {
        const safeQuery = queryTerm.replace(/"/g, '\\"');
        const fetchLimit = Math.max(20, page * pageSize);
        body = `search "${safeQuery}"; fields name, total_rating, total_rating_count, hypes, first_release_date, cover.image_id, game_type, category, id; where version_parent = null; limit ${fetchLimit};`;
    }

    try {
        const igdbRes = await fetch('https://api.igdb.com/v4/games', {
            method: 'POST',
            headers: {
                'Client-ID': clientId,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
                'User-Agent': USER_AGENT
            },
            body
        });

        const rawData = await igdbRes.json();
        if (!Array.isArray(rawData) || rawData.length === 0) {
            await sock.sendMessage(jid, { text: `❌ No games found for \`!sharkny list game ${subArg}\`.` });
            return;
        }

        let results = [];
        if (mode === 'search') {
            const ranked = rankIGDBResults(rawData, queryTerm);
            results = ranked.slice(offset, offset + pageSize);
        } else {
            results = rawData;
        }

        if (results.length === 0) {
            await sock.sendMessage(jid, { text: `ℹ️ No more results found on page ${page}.` });
            return;
        }

        let header = '';
        if (mode === 'popular') header = `🔥 *Popular Games (Last 30 Days — Page ${page})*:\n`;
        else if (mode === 'new') header = `🆕 *Newest Releases (Last 30 Days — Page ${page})*:\n`;
        else header = `🎮 *Game Results for "${queryTerm}" (Page ${page})*:\n`;

        await sock.sendMessage(jid, { text: header });

        for (let idx = 0; idx < results.length; idx++) {
            const g = results[idx];
            const rankNum = offset + idx + 1;
            const year = g.first_release_date ? new Date(g.first_release_date * 1000).getFullYear() : 'N/A';
            const ratingStr = g.total_rating ? ` | ⭐ ${Math.round(g.total_rating)}/100` : '';
            const link = `https://sharkny-three.vercel.app/game/${g.id}`;
            const caption = `*${rankNum}. ${g.name}* (${year}${ratingStr})\n🔗 ${link}`;

            const imageUrl = g.cover?.image_id
                ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg`
                : null;

            if (imageUrl) {
                await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption });
            } else {
                await sock.sendMessage(jid, { text: caption });
            }
            await new Promise(r => setTimeout(r, 1200));
        }

        const baseCmd = mode === 'search' ? queryTerm : mode;
        await sock.sendMessage(jid, { text: `📄 _Next page:_ \`!sharkny list game ${baseCmd} ${page + 1}\`` });
    } catch (error) {
        console.error('IGDB List Error:', error);
        await sock.sendMessage(jid, { text: '❌ Failed to fetch game list from IGDB.' });
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
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT }
        });

        const searchData = await searchRes.json();
        if (!searchData.results || searchData.results.length === 0) {
            return { text: `❌ No results found matching "${rawQuery}" on TMDB.` };
        }

        const ranked = rankTMDBResults(searchData.results, cleanQuery, year);
        const bestMatch = ranked[0];
        const runnersUp = ranked.slice(1, 3).map((r) => `${r.title || r.name}${r._year ? ` (${r._year})` : ''}`);

        const detailsRes = await fetch(`https://api.themoviedb.org/3/${endpoint}/${bestMatch.id}`, {
            headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT }
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

async function listTMDBMedia(mediaType, subArg, sock, jid) {
    const tmdbToken = process.env.TMDB_ACCESS_TOKEN;
    if (!tmdbToken) {
        await sock.sendMessage(jid, { text: '⚠️ TMDB access token is missing in your .env file.' });
        return;
    }

    if (!subArg) {
        await sock.sendMessage(jid, { text: `⚠️ Usage:\n• \`!sharkny list ${mediaType} popular [page]\`\n• \`!sharkny list ${mediaType} new [page]\`\n• \`!sharkny list ${mediaType} <query> [page]\`` });
        return;
    }

    const parts = subArg.trim().split(/\s+/);
    const firstToken = parts[0].toLowerCase();

    let mode = 'search';
    let page = 1;
    let queryTerm = '';
    const pageSize = 5;

    if (firstToken === 'popular' || firstToken === 'new') {
        mode = firstToken;
        if (parts[1] && /^\d+$/.test(parts[1])) {
            page = Math.max(1, parseInt(parts[1], 10));
        }
    } else {
        const lastToken = parts[parts.length - 1];
        if (parts.length > 1 && /^\d+$/.test(lastToken)) {
            page = Math.max(1, parseInt(lastToken, 10));
            queryTerm = parts.slice(0, -1).join(' ');
        } else {
            queryTerm = subArg.trim();
        }
    }

    const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
    const typeTitle = mediaType === 'tv' ? 'TV Shows' : 'Movies';

    try {
        let allResults = [];

        if (mode === 'popular') {
            const tmdbPage = Math.ceil((page * pageSize) / 20);
            const fetchUrl = `https://api.themoviedb.org/3/${endpoint}/popular?language=en-US&page=${tmdbPage}`;
            const res = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
            const data = await res.json();
            const sliceIndex = ((page - 1) * pageSize) % 20;
            allResults = (data.results || []).slice(sliceIndex, sliceIndex + pageSize);
        } else if (mode === 'new') {
            const tmdbPage = Math.ceil((page * pageSize) / 20);
            const fetchUrl = mediaType === 'tv'
                ? `https://api.themoviedb.org/3/tv/on_the_air?language=en-US&page=${tmdbPage}`
                : `https://api.themoviedb.org/3/movie/now_playing?language=en-US&page=${tmdbPage}`;
            const res = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
            const data = await res.json();
            const sliceIndex = ((page - 1) * pageSize) % 20;
            allResults = (data.results || []).slice(sliceIndex, sliceIndex + pageSize);
        } else {
            const fetchUrl = `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(queryTerm)}&include_adult=false&language=en-US&page=1`;
            const res = await fetch(fetchUrl, { headers: { 'Authorization': `Bearer ${tmdbToken}`, 'Accept': 'application/json', 'User-Agent': USER_AGENT } });
            const data = await res.json();
            const ranked = rankTMDBResults(data.results || [], queryTerm);
            const offset = (page - 1) * pageSize;
            allResults = ranked.slice(offset, offset + pageSize);
        }

        if (allResults.length === 0) {
            await sock.sendMessage(jid, { text: `❌ No results found on page ${page}.` });
            return;
        }

        let header = '';
        if (mode === 'popular') header = `🔥 *Popular ${typeTitle} (Page ${page})*:\n`;
        else if (mode === 'new') header = `🆕 *New / Airing ${typeTitle} (Page ${page})*:\n`;
        else header = `🎬 *${typeTitle} for "${queryTerm}" (Page ${page})*:\n`;

        await sock.sendMessage(jid, { text: header });

        for (let idx = 0; idx < allResults.length; idx++) {
            const item = allResults[idx];
            const rankNum = ((page - 1) * pageSize) + idx + 1;
            const title = item.title || item.name || 'Unknown';
            const rawDate = item.release_date || item.first_air_date;
            const year = rawDate ? new Date(rawDate).getFullYear() : 'N/A';
            const rating = item.vote_average ? ` | ⭐ ${item.vote_average.toFixed(1)}/10` : '';
            const link = `https://sharkny-three.vercel.app/${endpoint}/${item.id}`;
            const caption = `*${rankNum}. ${title}* (${year}${rating})\n🔗 ${link}`;

            const imageUrl = item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null;

            if (imageUrl) {
                await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption });
            } else {
                await sock.sendMessage(jid, { text: caption });
            }
            await new Promise(r => setTimeout(r, 1200));
        }

        const baseCmd = mode === 'search' ? queryTerm : mode;
        await sock.sendMessage(jid, { text: `📄 _Next page:_ \`!sharkny list ${mediaType} ${baseCmd} ${page + 1}\`` });
    } catch (error) {
        console.error('TMDB List Error:', error);
        await sock.sendMessage(jid, { text: `❌ Failed to fetch ${mediaType} list from TMDB.` });
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

    try {
        for (const modelName of AI_MODELS) {
            try {
                const response = await ai.models.generateContent({ model: modelName, contents: contents });
                return { text: response.text || '🤖 Gemini generated an empty response.' };
            } catch (error) {
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
// 2. FREE GAMES & BEST DEALS (STEAM STOREFRONT + CHEAPSHARK)
// ==========================================

const SENT_DEALS_FILE = './sent_deals.json';
const DISCOUNT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MIN_DISCOUNT = 50;

// Filter out obvious NSFW / adult shovelware titles
const NSFW_REGEX = /\b(hentai|sex|porn|nsfw|erotic|waifu|nude|nudity|strip|milf|furry\s+love|lust|succubus|harem|fetish|ecchi|uncensored|18\+)\b/i;

function isSafeTitle(title) {
    return title && !NSFW_REGEX.test(title);
}

function getDealAlertTargets() {
    const targets = [];
    if (process.env.ALERT_TARGET_JID) {
        targets.push(process.env.ALERT_TARGET_JID.trim());
    }
    const extraPrivateLid = '269844725379109@lid';
    if (!targets.includes(extraPrivateLid)) {
        targets.push(extraPrivateLid);
    }
    return targets;
}

function getSentDealsMap() {
    try {
        if (fs.existsSync(SENT_DEALS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(SENT_DEALS_FILE, 'utf8'));
            if (Array.isArray(parsed)) {
                const migrated = {};
                for (const key of parsed) {
                    migrated[key] = { timestamp: Date.now(), discount: 100 };
                }
                fs.writeFileSync(SENT_DEALS_FILE, JSON.stringify(migrated, null, 2));
                return migrated;
            }
            return parsed;
        }
    } catch (e) {
        console.error('Error reading sent_deals.json:', e);
    }
    return {};
}

function saveSentDeal(dealKey, discountPercent) {
    const dealsMap = getSentDealsMap();
    dealsMap[dealKey] = {
        timestamp: Date.now(),
        discount: discountPercent
    };
    fs.writeFileSync(SENT_DEALS_FILE, JSON.stringify(dealsMap, null, 2));
}

function shouldAlertDeal(dealsMap, dealKey, currentDiscount) {
    const record = dealsMap[dealKey];
    if (!record) return true;

    const elapsed = Date.now() - (record.timestamp || 0);
    if (elapsed >= DISCOUNT_COOLDOWN_MS) return true;
    if (currentDiscount > (record.discount || 0)) return true;

    return false;
}

// Batch-fetch Ukrainian Store prices (UAH / ₴) in chunks of 20 so Steam's API never truncates
async function getSteamUkrainePrices(appIds) {
    const uaMap = {};
    if (!appIds || appIds.length === 0) return uaMap;

    const chunkSize = 20;
    for (let i = 0; i < appIds.length; i += chunkSize) {
        const chunk = appIds.slice(i, i + chunkSize);
        try {
            const res = await fetch(
                `https://store.steampowered.com/api/appdetails?appids=${chunk.join(',')}&cc=ua&filters=price_overview`,
                { headers: { 'User-Agent': USER_AGENT } }
            );
            const data = await res.json();

            for (const id of chunk) {
                const po = data?.[id]?.data?.price_overview;
                if (po) {
                    uaMap[id] = {
                        original: po.initial_formatted || po.final_formatted || null,
                        final: po.final_formatted || null
                    };
                }
            }
        } catch (e) {
            console.error('[Deals] Steam Ukraine price lookup error:', e);
        }
    }

    return uaMap;
}

// Fetches all quality Steam deals (with optional custom minDiscount threshold, e.g., 90 for 90%+)
// No artificial 15-game cap—returns every matching well-reviewed game.
async function fetchBestSteamDeals(customMinDiscount = null) {
    const candidates = new Map();
    let activeEventName = null;
    const minPct = customMinDiscount !== null ? customMinDiscount : DEFAULT_MIN_DISCOUNT;

    // Source A: Steam Official Featured Categories (catches seasonal sales, top sellers & specials)
    try {
        const steamCatRes = await fetch('https://store.steampowered.com/api/featuredcategories/?cc=us&l=english', {
            headers: { 'User-Agent': USER_AGENT }
        });
        const catData = await steamCatRes.json();

        const possibleBanner = catData?.['0']?.name || catData?.specials?.name;
        if (possibleBanner && /sale|fest|event|autumn|summer|winter|spring/i.test(possibleBanner)) {
            activeEventName = possibleBanner;
        }

        const spotlightBuckets = [
            ...(catData?.specials?.items || []),
            ...(catData?.top_sellers?.items || [])
        ];

        const spotlightCutoff = customMinDiscount !== null ? customMinDiscount : 35;

        for (const item of spotlightBuckets) {
            const discount = item.discount_percent || 0;
            if (!item.id || !item.discounted || discount < spotlightCutoff || discount >= 100) continue;
            if (!isSafeTitle(item.name)) continue;

            const appId = String(item.id);
            const endsDate = item.discount_expiration
                ? new Date(item.discount_expiration * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : null;

            candidates.set(appId, {
                id: `steam_disc_${appId}`,
                appId,
                title: item.name,
                store: 'Steam',
                discount,
                originalPrice: `$${(item.original_price / 100).toFixed(2)}`,
                finalPrice: `$${(item.final_price / 100).toFixed(2)}`,
                isSteamSpotlight: true,
                reviewCount: 25000,
                metacritic: 80,
                startedDate: null,
                endsDate,
                link: `https://store.steampowered.com/app/${appId}`,
                image: item.large_capsule_image || item.header_image || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`
            });
        }
    } catch (e) {
        console.error('[Deals] Steam featuredcategories fetch error:', e);
    }

    // Source B: CheapShark sorted by Review Count & Quality
    // For high thresholds (85%+), lower review floor slightly to 1,000 so legitimate deep-discount hits aren't missed
    try {
        const minReviews = minPct >= 85 ? 1000 : 2500;
        const pageFetches = [0, 1].map(pageNum =>
            fetch(
                `https://www.cheapshark.com/api/1.0/deals?storeID=1&onSale=1&sortBy=Reviews&minimumReviewCount=${minReviews}&steamRating=75&pageSize=60&pageNumber=${pageNum}`,
                { headers: { 'User-Agent': USER_AGENT } }
            ).then(r => r.json()).catch(() => [])
        );

        const pages = await Promise.all(pageFetches);
        const csDeals = pages.flat();

        for (const d of csDeals) {
            const discount = Math.round(parseFloat(d.savings || '0'));
            if (!d.steamAppID || discount < minPct || discount >= 100) continue;
            if (!isSafeTitle(d.title)) continue;

            const appId = String(d.steamAppID);
            const startedDate = d.lastChange
                ? new Date(d.lastChange * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                : null;

            const existing = candidates.get(appId);
            if (existing) {
                existing.reviewCount = Math.max(existing.reviewCount, parseInt(d.steamRatingCount || '0', 10));
                existing.metacritic = Math.max(existing.metacritic, parseInt(d.metacriticScore || '0', 10));
                if (!existing.startedDate) existing.startedDate = startedDate;
            } else {
                candidates.set(appId, {
                    id: `steam_disc_${appId}`,
                    appId,
                    title: d.title,
                    store: 'Steam',
                    discount,
                    originalPrice: `$${d.normalPrice}`,
                    finalPrice: `$${d.salePrice}`,
                    isSteamSpotlight: false,
                    reviewCount: parseInt(d.steamRatingCount || '0', 10),
                    metacritic: parseInt(d.metacriticScore || '0', 10),
                    startedDate,
                    endsDate: null,
                    link: `https://store.steampowered.com/app/${appId}`,
                    image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`
                });
            }
        }
    } catch (e) {
        console.error('[Deals] CheapShark reviews-sorted fetch error:', e);
    }

    // Rank by overall deal quality: Discount % + Popularity (Review Count) + Metacritic + Steam Spotlight
    const ranked = Array.from(candidates.values())
        .map(game => {
            const spotlightBonus = game.isSteamSpotlight ? 35 : 0;
            const popularityBonus = Math.min(game.reviewCount / 2000, 45);
            const criticBonus = game.metacritic >= 80 ? (game.metacritic - 75) : 0;
            const score = game.discount + spotlightBonus + popularityBonus + criticBonus;
            return { ...game, _rankScore: score };
        })
        .sort((a, b) => b._rankScore - a._rankScore);

    if (ranked.length === 0) return { deals: [], eventName: activeEventName };

    // Batch-fetch Ukrainian Store prices (UAH / ₴) for all matched games
    const uaPrices = await getSteamUkrainePrices(ranked.map(g => g.appId));
    for (const game of ranked) {
        const ua = uaPrices[game.appId];
        game.uaOriginalPrice = ua?.original || null;
        game.uaFinalPrice = ua?.final || null;
    }

    return { deals: ranked, eventName: activeEventName };
}

// Fetch 100% Free Games (Steam via CheapShark + Epic Games Store)
async function fetchActiveFreebies() {
    let freebies = [];

    try {
        const res = await fetch('https://www.cheapshark.com/api/1.0/deals?storeID=1&onSale=1&upperPrice=0&pageSize=20', {
            headers: { 'User-Agent': USER_AGENT }
        });
        const steamFree = await res.json();
        if (Array.isArray(steamFree)) {
            for (const d of steamFree) {
                if (d.steamAppID && parseFloat(d.normalPrice || '0') > 0 && isSafeTitle(d.title)) {
                    freebies.push({
                        id: `steam_free_${d.steamAppID}`,
                        title: d.title,
                        store: 'Steam',
                        discount: 100,
                        originalPrice: `$${d.normalPrice}`,
                        finalPrice: 'FREE',
                        link: `https://store.steampowered.com/app/${d.steamAppID}`,
                        image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${d.steamAppID}/header.jpg`
                    });
                }
            }
        }
    } catch (e) {
        console.error('[Deals] Steam freebies fetch error:', e);
    }

    try {
        const epicRes = await fetch('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US', {
            headers: { 'User-Agent': USER_AGENT }
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
                freebies.push({
                    id: `epic_free_${game.id}`,
                    title: game.title,
                    store: 'Epic Games Store',
                    discount: 100,
                    originalPrice: game.price?.totalPrice?.fmtPrice?.originalPrice || 'Paid',
                    finalPrice: 'FREE',
                    link: storeLink,
                    image: imageObj?.url || null
                });
            }
        }
    } catch (e) {
        console.error('[Deals] Epic freebies fetch error:', e);
    }

    return freebies;
}

// Formats all ranked deals into clean WhatsApp message chunks (20 games per message so long lists never truncate)
function formatDiscountListMessages(deals, headerTitle) {
    const chunkSize = 20;
    const chunks = [];

    for (let start = 0; start < deals.length; start += chunkSize) {
        const slice = deals.slice(start, start + chunkSize);
        const lines = slice.map((d, i) => {
            const rank = start + i + 1;
            const uaPart = d.uaFinalPrice ? ` | 🇺🇦 *${d.uaFinalPrice}*` : '';
            let datePart = '';
            if (d.endsDate) datePart = ` _(Ends ${d.endsDate})_`;
            else if (d.startedDate) datePart = ` _(Since ${d.startedDate})_`;

            return `*${rank}. ${d.title}* — *-${d.discount}%*${datePart}\n` +
                   `   🇺🇸 ~${d.originalPrice}~ → *${d.finalPrice}*${uaPart}\n` +
                   `   🔗 ${d.link}`;
        });

        const partLabel = deals.length > chunkSize ? ` _(Part ${Math.floor(start / chunkSize) + 1}/${Math.ceil(deals.length / chunkSize)})_` : '';
        const titleLine = start === 0
            ? `${headerTitle} (${deals.length} Games)${partLabel}\n\n`
            : `${headerTitle}${partLabel}\n\n`;

        const footer = start + chunkSize >= deals.length
            ? `\n\n💡 _Tip: Type_ \`!discount <game name>\` _for full overview, reviews & specs._`
            : '';

        chunks.push(`${titleLine}${lines.join('\n\n')}${footer}`);
    }

    return chunks;
}

// Broadcasts a message or image card to all target chats with anti-spam intervals between each chat
async function broadcastToTargets(sock, targets, payload) {
    for (let i = 0; i < targets.length; i++) {
        const targetJid = targets[i];
        try {
            await sock.sendMessage(targetJid, payload);
            console.log(`[Deals Monitor] Sent alert to ${targetJid}`);
        } catch (err) {
            console.error(`[Deals Monitor] Failed sending alert to ${targetJid}:`, err);
        }

        if (i < targets.length - 1) {
            await sleepJitter(4000, 6000);
        }
    }
}

async function checkAllDeals(sock) {
    const targets = getDealAlertTargets();
    if (targets.length === 0) return;

    const dealsMap = getSentDealsMap();

    // 1. Check 100% Freebies
    const freebies = await fetchActiveFreebies();
    for (const deal of freebies) {
        if (shouldAlertDeal(dealsMap, deal.id, deal.discount)) {
            const messageText = `🚨 *FREE ${deal.store.toUpperCase()} ALERT!* 🚨\n\n🎮 *${deal.title}*\n💸 *Price:* ~${deal.originalPrice}~ → *100% FREE!*\n\n🔗 *Store Link:* ${deal.link}`;
            const payload = deal.image
                ? { image: { url: deal.image }, caption: messageText }
                : { text: messageText };

            await broadcastToTargets(sock, targets, payload);
            saveSentDeal(deal.id, deal.discount);
            await sleepJitter(8000, 12000);
        }
    }

    // 2. Check Top Ranked Deals & Seasonal Events (uncapped)
    const { deals, eventName } = await fetchBestSteamDeals();
    const newDiscounts = deals.filter(d => shouldAlertDeal(dealsMap, d.id, d.discount));

    if (newDiscounts.length > 0) {
        const bannerTitle = eventName
            ? `🎉 *STEAM ${eventName.toUpperCase()} — TOP DEALS* 🎉`
            : `🔥 *TOP STEAM DEALS RIGHT NOW* 🔥`;

        const messageChunks = formatDiscountListMessages(newDiscounts, bannerTitle);
        for (const chunkText of messageChunks) {
            await broadcastToTargets(sock, targets, { text: chunkText });
            if (messageChunks.length > 1) await sleepJitter(3000, 5000);
        }

        for (const deal of newDiscounts) {
            saveSentDeal(deal.id, deal.discount);
        }
    }
}

function startDealsMonitor(sock) {
    checkAllDeals(sock);
    setInterval(() => checkAllDeals(sock), 3 * 60 * 60 * 1000);
    console.log(`[Deals Monitor] Active for targets: ${getDealAlertTargets().join(', ')}`);
}

// On-demand detailed lookup for !discount <gamename>
async function handleDiscountDetail(gameQuery, sock, jid) {
    await sock.sendMessage(jid, { text: `🔍 Checking Steam store & pricing for "${gameQuery}"...` });

    try {
        const searchRes = await fetch(
            `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(gameQuery)}&l=english&cc=us`,
            { headers: { 'User-Agent': USER_AGENT } }
        );
        const searchData = await searchRes.json();
        const firstHit = searchData?.items?.[0];

        if (!firstHit) {
            await sock.sendMessage(jid, { text: `❌ No Steam game found matching "${gameQuery}".` });
            return;
        }

        const appId = firstHit.id;

        const [usRes, uaRes] = await Promise.all([
            fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us`, { headers: { 'User-Agent': USER_AGENT } }),
            fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=ua&filters=price_overview`, { headers: { 'User-Agent': USER_AGENT } })
        ]);

        const [usData, uaData] = await Promise.all([usRes.json(), uaRes.json()]);
        const appInfo = usData?.[appId]?.data;
        const uaPrice = uaData?.[appId]?.data?.price_overview;

        if (!appInfo) {
            await sock.sendMessage(jid, { text: `❌ Could not load Steam store details for "${firstHit.name}".` });
            return;
        }

        const title = appInfo.name || firstHit.name;
        const po = appInfo.price_overview;
        const desc = appInfo.short_description ? appInfo.short_description.slice(0, 280) + '...' : 'No description available.';
        const genres = appInfo.genres ? appInfo.genres.map(g => g.description).join(', ') : 'N/A';
        const releaseDate = appInfo.release_date?.date || 'Unknown';
        const metacritic = appInfo.metacritic?.score ? `${appInfo.metacritic.score}/100` : 'N/A';

        let priceBlock = '';
        if (appInfo.is_free) {
            priceBlock = '💸 *Price:* Free to Play';
        } else if (po) {
            if (po.discount_percent > 0) {
                priceBlock = `🔥 *Discount:* *-${po.discount_percent}% OFF*\n🇺🇸 *US Store:* ~${po.initial_formatted}~ → *${po.final_formatted}*`;
                if (uaPrice) {
                    priceBlock += `\n🇺🇦 *UA Store:* ~${uaPrice.initial_formatted}~ → *${uaPrice.final_formatted}*`;
                }
            } else {
                priceBlock = `💰 *US Store:* *${po.final_formatted}* _(No active discount)_`;
                if (uaPrice) {
                    priceBlock += `\n🇺🇦 *UA Store:* *${uaPrice.final_formatted}*`;
                }
            }
        } else {
            priceBlock = '💰 *Price:* Not available';
        }

        const caption =
            `🎮 *${title}* (${releaseDate})\n\n` +
            `${priceBlock}\n\n` +
            `⭐ *Metacritic:* ${metacritic}\n` +
            `🏷️ *Genres:* ${genres}\n\n` +
            `📝 *Overview:* ${desc}\n\n` +
            `🔗 *Steam Store:* https://store.steampowered.com/app/${appId}`;

        const headerImg = appInfo.header_image || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
        await sock.sendMessage(jid, { image: { url: headerImg }, caption });
    } catch (e) {
        console.error('Discount Detail Error:', e);
        await sock.sendMessage(jid, { text: '❌ Failed to fetch detailed discount information from Steam.' });
    }
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
                      `*1. Single Lookups (with optional year parsing):*\n` +
                      `• \`!sharkny game <title> [year]\`\n` +
                      `• \`!sharkny movie <title> [year]\`\n` +
                      `• \`!sharkny tv <title> [year]\`\n\n` +
                      `*2. 5-Item Lists & Pagination (with cover images):*\n` +
                      `• \`!sharkny list game popular [page]\`\n` +
                      `• \`!sharkny list movie new [page]\`\n` +
                      `• \`!sharkny list tv <query> [page]\`\n\n` +
                      `🔗 *Main Platform:* https://sharkny-three.vercel.app`
            };
        }

        return {
            text: `🤖 *Sharkny Bot Command Center* 🤖\n\n` +
                  `• \`!sharkny ...\` — Search single titles or browse 5-item paged lists.\n` +
                  `• \`!ai <prompt>\` — Chat with Gemini (supports quoted image/text context).\n` +
                  `• \`!deals free\` — View active 100% free games on Steam & Epic Games.\n` +
                  `• \`!deals discount [min%]\` — Top-ranked Steam deals (optional min %, e.g. \`!deals discount 90\`).\n` +
                  `• \`!discount <gamename>\` — Get detailed price, discount & game info for any Steam game.\n` +
                  `• \`!ping\` — Test bot response time.\n` +
                  `• \`!help sharkny\` — Detailed documentation for Sharkny search & lists.`
        };
    },
    '!sharkny': async (args, msg, sock) => {
        const jid = msg.key.remoteJid;
        if (!args) {
            await sock.sendMessage(jid, {
                text: '⚠️ Usage:\n• `!sharkny <game|tv|movie> <query> [year]`\n• `!sharkny list <game|tv|movie> <popular|new|query> [page]`\n• Type `!help sharkny` for full documentation.'
            });
            return;
        }

        const firstSpace = args.indexOf(' ');
        if (firstSpace === -1) {
            await sock.sendMessage(jid, { text: '⚠️ Please include a search query or subcommand. Type `!help sharkny` for details.' });
            return;
        }

        const subCmd = args.slice(0, firstSpace).toLowerCase();
        const rest = args.slice(firstSpace + 1).trim();

        if (subCmd === 'list') {
            const secondSpace = rest.indexOf(' ');
            const listType = (secondSpace === -1 ? rest : rest.slice(0, secondSpace)).toLowerCase();
            const listArgs = secondSpace === -1 ? '' : rest.slice(secondSpace + 1).trim();

            if (listType === 'game') {
                await listIGDBGames(listArgs, sock, jid);
                return;
            }
            if (listType === 'movie' || listType === 'tv') {
                await listTMDBMedia(listType, listArgs, sock, jid);
                return;
            }
            await sock.sendMessage(jid, { text: `❌ Unknown list type "${listType}". Use \`game\`, \`movie\`, or \`tv\`.` });
            return;
        }

        if (subCmd === 'game') return await searchIGDB(rest);
        if (subCmd === 'tv' || subCmd === 'movie') return await searchTMDB(subCmd, rest);
        return { text: `❌ Unknown type "${subCmd}". Use \`game\`, \`tv\`, \`movie\`, or \`list <type>\`. Type \`!help\` for commands.` };
    },
    '!ai': handleAI,
    '!ping': async () => ({ text: 'Pong! 🏓' }),
    '!discount': async (args, msg, sock) => {
        const jid = msg.key.remoteJid;
        if (!args) {
            await sock.sendMessage(jid, { text: '⚠️ Usage: `!discount <gamename>` (e.g. `!discount persona 5 royal`)' });
            return;
        }
        await handleDiscountDetail(args.trim(), sock, jid);
    },
    '!deals': async (args, msg, sock) => {
        const jid = msg.key.remoteJid;
        const parts = (args || 'free').trim().split(/\s+/);
        const subCmd = parts[0].toLowerCase();

        if (subCmd === 'free') {
            await sock.sendMessage(jid, { text: '🔍 Scanning Steam and Epic Games for active 100% free games...' });
            const freebies = await fetchActiveFreebies();
            if (freebies.length === 0) {
                return { text: 'ℹ️ There are currently no active 100% free game promotions running.' };
            }

            await sock.sendMessage(jid, { text: `🎯 Found *${freebies.length}* active free game(s) right now:` });
            for (const deal of freebies) {
                const cardText = `🎮 *${deal.title}* (${deal.store})\n💸 *Price:* ~${deal.originalPrice}~ → *100% FREE*\n\n🔗 *Store Link:* ${deal.link}`;
                if (deal.image) {
                    await sock.sendMessage(jid, { image: { url: deal.image }, caption: cardText });
                } else {
                    await sock.sendMessage(jid, { text: cardText });
                }
                await sleepJitter(2000, 3000);
            }
            return;
        }

        if (subCmd === 'discount' || subCmd === 'discounts') {
            let customPct = null;
            if (parts[1]) {
                const parsedPct = parseInt(parts[1].replace('%', ''), 10);
                if (isNaN(parsedPct) || parsedPct < 10 || parsedPct > 99) {
                    return { text: '⚠️ Please enter a valid discount percentage between 10 and 99 (e.g., `!deals discount 90`).' };
                }
                customPct = parsedPct;
            }

            const statusMsg = customPct !== null
                ? `🔍 Fetching top-ranked Steam deals with *${customPct}%+ off* (US & Ukraine stores)...`
                : '🔍 Fetching all top-ranked Steam deals & seasonal sale highlights (US & Ukraine stores)...';

            await sock.sendMessage(jid, { text: statusMsg });

            const { deals, eventName } = await fetchBestSteamDeals(customPct);
            if (deals.length === 0) {
                return {
                    text: customPct !== null
                        ? `ℹ️ No well-reviewed Steam games found at *${customPct}%+ off* right now.`
                        : 'ℹ️ No major Steam discounts found right now.'
                };
            }

            let headerTitle = '';
            if (customPct !== null) {
                headerTitle = `🔥 *TOP STEAM DEALS (${customPct}%+ OFF)* 🔥`;
            } else if (eventName) {
                headerTitle = `🎉 *STEAM ${eventName.toUpperCase()} — TOP DEALS* 🎉`;
            } else {
                headerTitle = `🔥 *TOP STEAM DEALS RIGHT NOW* 🔥`;
            }

            const messageChunks = formatDiscountListMessages(deals, headerTitle);
            for (const chunkText of messageChunks) {
                await sock.sendMessage(jid, { text: chunkText });
                if (messageChunks.length > 1) await sleepJitter(1500, 2500);
            }
            return;
        }

        return { text: '⚠️ Usage:\n• `!deals free` — Active 100% free games\n• `!deals discount [min%]` — Top-ranked Steam deals (e.g., `!deals discount 90`)\n• `!discount <gamename>` — Detailed info for any Steam game' };
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