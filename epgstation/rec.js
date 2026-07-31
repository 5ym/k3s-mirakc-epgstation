const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = process.env.XOOL_ENDPOINT || 'http://xool.xool:3000/api/tweets';
// Posts that cannot go out right away wait here, on the persistent volume, so a
// later run picks them up once x.com lifts the limit.
const QUEUE_DIR = process.env.XOOL_QUEUE_DIR || '/app/data/tweet-queue';
const MAX_INLINE_WAIT = 60 * 1000;
const MAX_INLINE_ATTEMPTS = 3;
const MAX_BACKOFF = 15 * 60 * 1000;
// x.com rejects some requests without saying when to come back.
const BLIND_BACKOFF = 60 * 60 * 1000;
// A recording notice nobody read within a day is not worth posting anymore.
const MAX_AGE = 24 * 60 * 60 * 1000;

function count (str) {
    let len = 0;
    for (let i = 0; i < str.length; i++) {
        (str[i].match(/[ -~]|\n/)) ? len += 1 : len += 2;
    }
    return len;
}

head = "";
switch(process.argv[2]) {
    case 'add':
        head = "Recording has been added.";
        break;
    case 'update':
        head = "Recording has been updated.";
        break;
    case 'delete':
        head = "Recording has been deleted.";
        break;
    case 'failprep':
        head = "Failed to prepare for recording.";
        break;
    case 'fail':
        head = "Failed while recording.";
        break;
    case 'encode':
        head = "Encoding has been completed.";
        break;
}
channel = `Channel:${process.env.HALF_WIDTH_CHANNELNAME}`
title = `Title:${process.env.HALF_WIDTH_NAME}`
description = `Description:${process.env.HALF_WIDTH_DESCRIPTION}`
to = '@5yuim'
text = `${head}\n${title}\n${channel}`
if (count(`${text}\n${description}\n${to}`) < 280) {
    text += `\n${description}`
}
text += `\n${to}`

function sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function post (text) {
    let res = null
    try {
        res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                key: process.env.XOOL_API_KEY,
                text: text,
            })
        })
    } catch (error) {
        return { ok: false, status: null, rateLimit: null, body: String(error) }
    }

    const body = await res.text()
    let result = null
    try {
        result = JSON.parse(body)
    } catch (error) {
        return { ok: false, status: res.status, rateLimit: null, body: body }
    }

    const rateLimit = result.rateLimit || null
    // The endpoint answers 200 even when x.com rejects the post, reporting it
    // either as {error} or as an x.com error object {status, title, detail}.
    const rejected = !res.ok || result.error || result.errors || result.detail || result.status >= 400
    let status = res.status
    if (rateLimit && rateLimit.httpStatus) {
        status = rateLimit.httpStatus
    } else if (res.ok && typeof result.status === 'number') {
        status = result.status
    }
    return { ok: !rejected, status: status, rateLimit: rateLimit, body: body }
}

// How long to hold off before trying a rejected post again, or null when no
// later attempt could succeed. x.com reports the window it is enforcing in the
// response headers, which the endpoint passes through as rateLimit.
function retryDelay (attempt, status, rateLimit) {
    if (status === 400 || status === 401 || status === 404) {
        return null
    }
    if (rateLimit) {
        if (rateLimit.retryAfter) {
            return rateLimit.retryAfter * 1000
        }
        const daily = rateLimit.daily
        if (daily && daily.remaining === 0 && daily.reset) {
            return Math.max(daily.reset * 1000 - Date.now(), 0)
        }
        if (rateLimit.remaining === 0 && rateLimit.reset) {
            return Math.max(rateLimit.reset * 1000 - Date.now(), 0)
        }
    }
    if (status === null || status === 429 || status >= 500) {
        return Math.min(60 * 1000 * 2 ** attempt, MAX_BACKOFF)
    }
    if (status === 403) {
        return BLIND_BACKOFF
    }
    return null
}

function enqueue (item) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true })
    const name = `${item.createdAt}-${process.pid}.json`
    fs.writeFileSync(path.join(QUEUE_DIR, name), JSON.stringify(item))
}

async function flushQueue () {
    let names = []
    try {
        names = fs.readdirSync(QUEUE_DIR).filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
        return
    }

    for (const name of names) {
        const file = path.join(QUEUE_DIR, name)
        let item = null
        try {
            item = JSON.parse(fs.readFileSync(file, 'utf8'))
        } catch (error) {
            fs.unlinkSync(file)
            continue
        }
        if (Date.now() - item.createdAt > MAX_AGE) {
            console.error(`giving up on ${name}, last error: ${item.lastError}`)
            fs.unlinkSync(file)
            continue
        }
        if (Date.now() < item.notBefore) {
            continue
        }

        const res = await post(item.text)
        if (res.ok) {
            fs.unlinkSync(file)
            console.log(`posted ${name}`)
            continue
        }
        const delay = retryDelay(item.attempts + 1, res.status, res.rateLimit)
        if (delay === null) {
            console.error(`giving up on ${name}: ${res.body}`)
            fs.unlinkSync(file)
            continue
        }
        item.attempts += 1
        item.notBefore = Date.now() + delay
        item.lastError = res.body
        fs.writeFileSync(file, JSON.stringify(item))
        // Whatever blocks this one blocks the rest, so stop knocking.
        break
    }
}

async function main () {
    await flushQueue()

    for (let attempt = 1; ; attempt++) {
        const res = await post(text)
        if (res.ok) {
            console.log(res.body)
            return
        }
        const delay = retryDelay(attempt, res.status, res.rateLimit)
        if (delay === null) {
            throw new Error(`rejected: ${res.body}`)
        }
        if (delay <= MAX_INLINE_WAIT && attempt < MAX_INLINE_ATTEMPTS) {
            await sleep(delay)
            continue
        }
        enqueue({
            text: text,
            createdAt: Date.now(),
            attempts: attempt,
            notBefore: Date.now() + delay,
            lastError: res.body,
        })
        throw new Error(`queued for ${new Date(Date.now() + delay).toISOString()}: ${res.body}`)
    }
}

main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
})
