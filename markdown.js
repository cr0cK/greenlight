const LINK_COLOR = '#78aeed';
const MAX_BODY_CHARACTERS = 6000;
const MAX_LIST_DEPTH = 4;
const ALERT_TITLES = {
    note: 'Note',
    tip: 'Tip',
    important: 'Important',
    warning: 'Warning',
    caution: 'Caution',
};
// Inline HTML that GitHub renders as text styling; other tags are dropped, keeping their text.
const HTML_STYLES = {
    b: 'bold',
    strong: 'bold',
    i: 'italic',
    em: 'italic',
    code: 'code',
    kbd: 'code',
    tt: 'code',
    u: 'underline',
    ins: 'underline',
    s: 'strike',
    del: 'strike',
    strike: 'strike',
    sup: null,
    sub: null,
    small: null,
    span: null,
};
const EMPHASIS = [['**', 'bold'], ['__', 'bold'], ['~~', 'strike'], ['*', 'italic'], ['_', 'italic']];

function escapeMarkup(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function decodeEntities(text) {
    return text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/** Finds a closing emphasis delimiter that follows non-space text, as GitHub requires. */
function findClosingDelimiter(source, delimiter, from) {
    for (let index = source.indexOf(delimiter, from); index !== -1;
        index = source.indexOf(delimiter, index + 1)) {
        const before = source[index - 1];
        const after = source[index + delimiter.length] ?? '';
        if (!before || /\s/.test(before))
            continue;
        if (delimiter[0] === '_' && /\w/.test(after))
            continue;
        if (delimiter === '*' && (after === '*' || before === '*'))
            continue;
        // In ***text***, the bold run closes on the last two stars.
        if (delimiter.length === 2 && after === delimiter[0])
            continue;
        return index;
    }
    return -1;
}

/**
 * Reads a link destination and optional title starting after `](`. Parentheses inside the
 * destination may nest when balanced, as CommonMark allows. Returns null when unterminated.
 */
function readLinkDestination(source, start) {
    let index = start;
    while (source[index] === ' ')
        index++;

    let url = '';
    if (source[index] === '<') {
        const close = source.indexOf('>', index);
        if (close === -1)
            return null;
        url = source.slice(index + 1, close);
        index = close + 1;
    } else {
        let depth = 0;
        for (; index < source.length && !/\s/.test(source[index]); index++) {
            if (source[index] === '(') {
                depth++;
            } else if (source[index] === ')') {
                if (depth === 0)
                    break;
                depth--;
            }
            url += source[index];
        }
    }

    const title = /^\s+(?:"[^"]*"|'[^']*')/.exec(source.slice(index));
    if (title)
        index += title[0].length;
    while (source[index] === ' ')
        index++;
    return source[index] === ')' && url ? {url, end: index + 1} : null;
}

/** Trims trailing punctuation from a bare URL, keeping a closing parenthesis it opened. */
function trimBareUrl(url) {
    let trimmed = url.replace(/[.,;:!?]+$/, '');
    while (trimmed.endsWith(')') &&
        (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length)
        trimmed = trimmed.slice(0, -1).replace(/[.,;:!?]+$/, '');
    return trimmed;
}

/** Splits inline Markdown and inline HTML into styled text spans. */
function parseInline(source, style, spans, context) {
    let text = '';
    const flush = () => {
        if (text)
            spans.push({...style, text: decodeEntities(text)});
        text = '';
    };
    const push = span => {
        flush();
        spans.push({...style, ...span});
    };

    let index = 0;
    while (index < source.length) {
        const rest = source.slice(index);
        const previous = source[index - 1] ?? ' ';
        let match;

        if ((match = /^\\([\\`*_{}[\]()#+\-.!~|<>])/.exec(rest))) {
            text += match[1];
            index += 2;
            continue;
        }
        if ((match = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
            push({code: true, text: match[2].trim()});
            index += match[0].length;
            continue;
        }
        let destination;
        if ((match = /^!\[([^\]]*)\]\(/.exec(rest)) &&
            (destination = readLinkDestination(rest, match[0].length))) {
            push({url: destination.url, text: '🖼 ' + (match[1] || 'image')});
            index += destination.end;
            continue;
        }
        if (!style.url && (match = /^\[((?:[^[\]]|\[[^\]]*\])+)\]\(/.exec(rest)) &&
            (destination = readLinkDestination(rest, match[0].length))) {
            flush();
            parseInline(match[1], {...style, url: destination.url}, spans, context);
            index += destination.end;
            continue;
        }
        if ((match = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
            push({url: match[1], text: match[1]});
            index += match[0].length;
            continue;
        }
        if (!style.url && /[\s(]/.test(previous) && (match = /^https?:\/\/[^\s<]+/.exec(rest))) {
            const url = trimBareUrl(match[0]);
            push({url, text: url});
            index += url.length;
            continue;
        }
        if (!style.url && (match = /^<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(rest))) {
            flush();
            parseInline(match[2], {...style, url: match[1]}, spans, context);
            index += match[0].length;
            continue;
        }
        if ((match = /^<img\s[^>]*>/i.exec(rest))) {
            const alt = /\balt="([^"]*)"/i.exec(match[0])?.[1];
            const src = /\bsrc="([^"]*)"/i.exec(match[0])?.[1];
            push({url: src ?? null, text: '🖼 ' + (alt || 'image')});
            index += match[0].length;
            continue;
        }
        if ((match = /^<br\s*\/?>/i.exec(rest))) {
            text += '\n';
            index += match[0].length;
            continue;
        }
        if ((match = /^<([A-Za-z]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/.exec(rest)) &&
            match[1].toLowerCase() in HTML_STYLES) {
            const flag = HTML_STYLES[match[1].toLowerCase()];
            flush();
            parseInline(match[2], flag ? {...style, [flag]: true} : style, spans, context);
            index += match[0].length;
            continue;
        }
        if ((match = /^<\/?[A-Za-z][^>]*>/.exec(rest))) {
            index += match[0].length;
            continue;
        }

        const emphasis = EMPHASIS.find(([delimiter]) => rest.startsWith(delimiter) &&
            rest[delimiter.length] && !/\s/.test(rest[delimiter.length]) &&
            !(delimiter[0] === '_' && /\w/.test(previous)));
        if (emphasis) {
            const [delimiter, flag] = emphasis;
            const closing = findClosingDelimiter(source, delimiter, index + delimiter.length + 1);
            if (closing !== -1) {
                flush();
                parseInline(source.slice(index + delimiter.length, closing),
                    {...style, [flag]: true}, spans, context);
                index = closing + delimiter.length;
                continue;
            }
        }

        if (!style.url && /\W/.test(previous) &&
            (match = /^@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/.exec(rest))) {
            push({bold: true, url: 'https://github.com/' + match[1], text: match[0]});
            index += match[0].length;
            continue;
        }
        if (!style.url && context.repository && /[\s(]/.test(previous) &&
            (match = /^#(\d+)\b/.exec(rest))) {
            push({
                url: 'https://github.com/' + context.repository + '/issues/' + match[1],
                text: match[0],
            });
            index += match[0].length;
            continue;
        }

        text += source[index];
        index++;
    }
    flush();
}

/**
 * Renders inline Markdown to Pango markup. Link offsets count Unicode characters of the
 * rendered text, which is what ClutterText positions use. Only http(s) links are kept.
 */
export function renderInline(source, context = {}) {
    const spans = [];
    parseInline(source, {}, spans, context);

    let markup = '';
    let offset = 0;
    const links = [];
    for (const span of spans) {
        const url = /^https?:\/\//i.test(span.url ?? '') ? span.url : null;
        let open = '';
        let close = '';
        const wrap = (start, end) => {
            open += start;
            close = end + close;
        };
        if (span.bold)
            wrap('<b>', '</b>');
        if (span.italic)
            wrap('<i>', '</i>');
        if (span.strike)
            wrap('<s>', '</s>');
        if (span.underline)
            wrap('<u>', '</u>');
        if (span.code)
            wrap('<span font_family="monospace" background="#808080" bgalpha="25%">', '</span>');
        if (url)
            wrap('<span foreground="' + LINK_COLOR + '">', '</span>');
        markup += open + escapeMarkup(span.text) + close;

        const length = [...span.text].length;
        const last = links.at(-1);
        if (url && last?.url === url && last.end === offset)
            last.end += length;
        else if (url)
            links.push({start: offset, end: offset + length, url});
        offset += length;
    }
    return {markup, links};
}

function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map(cell => cell.trim());
}

/**
 * Parses a GitHub description into display blocks. Single newlines are hard breaks, as in
 * GitHub issues and pull requests; HTML comments disappear and very long bodies are cut.
 */
export function parseMarkdown(body, {repository = null, maxCharacters = MAX_BODY_CHARACTERS} = {}) {
    let source = (body ?? '').replace(/\r/g, '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
    const truncated = source.length > maxCharacters;
    if (truncated)
        source = source.slice(0, maxCharacters);

    const context = {repository};
    const inline = text => renderInline(text, context);
    const lines = source.split('\n');
    const blocks = [];
    let paragraph = [];
    let listIndents = [];
    const flushParagraph = () => {
        const rendered = inline(paragraph.join('\n'));
        // Lines holding only dropped HTML tags render to nothing; they leave no gap.
        if (rendered.markup.trim())
            blocks.push({type: 'paragraph', ...rendered});
        paragraph = [];
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmed = line.trim();
        let match;
        if (!/^(\s*)([-*+]|\d+[.)])\s+/.test(line) && !/^\s{2,}\S/.test(line))
            listIndents = [];

        if ((match = /^\s*(```+|~~~+)/.exec(line))) {
            flushParagraph();
            const code = [];
            for (index++; index < lines.length && !lines[index].trim().startsWith(match[1]); index++)
                code.push(lines[index]);
            blocks.push({type: 'code', text: code.join('\n')});
            continue;
        }
        if (!trimmed) {
            flushParagraph();
            continue;
        }
        if (paragraph.length && /^(=+|-+)$/.test(trimmed)) {
            const text = paragraph.join('\n');
            paragraph = [];
            blocks.push({type: 'heading', level: trimmed[0] === '=' ? 1 : 2, ...inline(text)});
            continue;
        }
        if ((match = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line)) ||
            (match = /^\s*<h([1-6])[^>]*>(.*)<\/h\1>\s*$/i.exec(line))) {
            flushParagraph();
            const level = match[1].startsWith('#') ? match[1].length : Number(match[1]);
            blocks.push({type: 'heading', level, ...inline(match[2])});
            continue;
        }
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            flushParagraph();
            blocks.push({type: 'rule'});
            continue;
        }
        if (/^\s*<\/?(?:details|p|div|blockquote)(?:\s[^>]*)?>\s*$/i.test(line))
            continue;
        if ((match = /^\s*(?:<details[^>]*>)?\s*<summary[^>]*>([\s\S]*?)<\/summary>\s*$/i.exec(line))) {
            flushParagraph();
            blocks.push({type: 'summary', ...inline(match[1])});
            continue;
        }
        if (/^\s{0,3}>/.test(line)) {
            flushParagraph();
            const quoted = [];
            for (; index < lines.length && /^\s{0,3}>/.test(lines[index]); index++)
                quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
            index--;
            const alert = /^\[!(note|tip|important|warning|caution)\]\s*$/i.exec(quoted[0] ?? '');
            if (alert)
                quoted.shift();
            const kind = alert?.[1].toLowerCase() ?? null;
            blocks.push({
                type: 'quote',
                alert: kind,
                title: kind ? ALERT_TITLES[kind] : null,
                ...inline(quoted.join('\n').trim()),
            });
            continue;
        }
        if (line.includes('|') && /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[index + 1] ?? '')) {
            flushParagraph();
            const rows = [splitTableRow(line)];
            for (index += 2; index < lines.length && lines[index].includes('|') && lines[index].trim(); index++)
                rows.push(splitTableRow(lines[index]));
            index--;
            blocks.push({type: 'table', rows: rows.map(row => row.map(inline))});
            continue;
        }
        if ((match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
            flushParagraph();
            const indent = match[1].replace(/\t/g, '    ').length;
            while (listIndents.length && indent < listIndents.at(-1))
                listIndents.pop();
            if (!listIndents.length || indent > listIndents.at(-1))
                listIndents.push(indent);

            let text = match[3];
            let marker = /\d/.test(match[2]) ? match[2].replace(')', '.') : '•';
            let checked = null;
            const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
            if (task) {
                checked = task[1] !== ' ';
                marker = checked ? '☑' : '☐';
                text = task[2];
            }
            while (/^\s{2,}\S/.test(lines[index + 1] ?? '') &&
                !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index + 1]))
                text += '\n' + lines[++index].trim();

            blocks.push({
                type: 'list-item',
                depth: Math.min(listIndents.length - 1, MAX_LIST_DEPTH),
                marker,
                checked,
                ...inline(text),
            });
            continue;
        }
        paragraph.push(trimmed);
    }
    flushParagraph();
    if (truncated)
        blocks.push({type: 'truncated'});
    return blocks;
}
