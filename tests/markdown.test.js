import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parseMarkdown, renderInline} from '../markdown.js';

const CODE = '<span font_family="monospace" background="#808080" bgalpha="25%">';
const LINK = '<span foreground="#78aeed">';

test('renders emphasis, code, strike, and underline as Pango markup', () => {
    assert.equal(
        renderInline('**bold** *it* _it_ ~~gone~~ `x < y` <ins>u</ins> <kbd>Ctrl</kbd>').markup,
        '<b>bold</b> <i>it</i> <i>it</i> <s>gone</s> ' + CODE + 'x &lt; y</span> <u>u</u> ' +
        CODE + 'Ctrl</span>');
    assert.equal(renderInline('***both***').markup, '<b><i>both</i></b>');
});

test('leaves snake_case, lone stars, and escapes as text', () => {
    assert.equal(renderInline('snake_case_name and 2 * 3 * 4').markup,
        'snake_case_name and 2 * 3 * 4');
    assert.equal(renderInline('\\*not italic\\* & <tag>').markup, '*not italic* &amp; ');
});

test('records link offsets in rendered characters', () => {
    const {markup, links} = renderInline('See 🚀 [the **docs**](https://docs.example) now');
    assert.equal(markup,
        'See 🚀 ' + LINK + 'the </span><b>' + LINK + 'docs</span></b> now');
    assert.deepEqual(links, [{start: 6, end: 14, url: 'https://docs.example'}]);
});

test('links bare URLs, autolinks, mentions, issue references, and HTML anchors', () => {
    const {links} = renderInline(
        'Go https://x.dev/a. <https://y.dev> @octo-cat fixes #12 <a href="https://z.dev">z</a>',
        {repository: 'o/r'});
    assert.deepEqual(links.map(link => link.url), [
        'https://x.dev/a',
        'https://y.dev',
        'https://github.com/octo-cat',
        'https://github.com/o/r/issues/12',
        'https://z.dev',
    ]);
    assert.deepEqual(renderInline('mail a@b.c and #12 without repo').links, []);
});

test('keeps balanced parentheses in link destinations and bare URLs', () => {
    assert.deepEqual(renderInline('[link](https://example.com/a(b)) end').links,
        [{start: 0, end: 4, url: 'https://example.com/a(b)'}]);
    assert.equal(renderInline('[link](https://example.com/a(b)) end').markup,
        LINK + 'link</span> end');
    assert.equal(renderInline('[t](<https://x.dev/a b> "Title")').links[0].url, 'https://x.dev/a b');
    assert.deepEqual(
        renderInline('see https://en.wikipedia.org/wiki/Foo_(bar). and (https://x.dev/y)').links
            .map(link => link.url),
        ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://x.dev/y']);
    // An unterminated link stays literal text; its bare URL still autolinks, as on GitHub.
    assert.equal(renderInline('[broken](https://x.dev').markup,
        '[broken](' + LINK + 'https://x.dev</span>');
});

test('keeps non-http links as plain text', () => {
    const {markup, links} = renderInline('[local](file:///etc/passwd) [rel](../README.md)');
    assert.equal(markup, 'local rel');
    assert.deepEqual(links, []);
});

test('shows images as labeled placeholders that link to the image', () => {
    const {markup, links} = renderInline('![diagram](https://i.dev/a.png) <img src="https://i.dev/b.png">');
    assert.equal(markup, LINK + '🖼 diagram</span> ' + LINK + '🖼 image</span>');
    assert.equal(links.length, 2);
});

test('parses GitHub blocks with hard line breaks', () => {
    const blocks = parseMarkdown([
        '<!-- template -->',
        '## Why',
        'First line',
        'second line',
        '',
        '- one',
        '  continued',
        '  - nested',
        '- [x] done',
        '1. first',
        '',
        '```js',
        'const a = 1;',
        '```',
        '> [!WARNING]',
        '> Careful',
        '---',
        '| A | B |',
        '|---|:-:|',
        '| 1 | **2** |',
        '<details><summary>More</summary>',
        'Title',
        '===',
    ].join('\r\n'));

    assert.deepEqual(blocks.map(block => block.type), [
        'heading', 'paragraph', 'list-item', 'list-item', 'list-item', 'list-item',
        'code', 'quote', 'rule', 'table', 'summary', 'heading',
    ]);
    assert.equal(blocks[0].level, 2);
    assert.equal(blocks[1].markup, 'First line\nsecond line');
    assert.equal(blocks[2].markup, 'one\ncontinued');
    assert.deepEqual(blocks.slice(2, 6).map(block => [block.depth, block.marker]),
        [[0, '•'], [1, '•'], [0, '☑'], [0, '1.']]);
    assert.equal(blocks[6].text, 'const a = 1;');
    assert.deepEqual([blocks[7].alert, blocks[7].title, blocks[7].markup], ['warning', 'Warning', 'Careful']);
    assert.deepEqual(blocks[9].rows.map(row => row.map(cell => cell.markup)), [['A', 'B'], ['1', '<b>2</b>']]);
    assert.equal(blocks[10].markup, 'More');
    assert.deepEqual([blocks[11].level, blocks[11].markup], [1, 'Title']);
});

test('reads a summary on its own line and HTML headings', () => {
    const blocks = parseMarkdown('<details>\n<summary>Logs</summary>\n\nbody\n</details>\n<h3 align="center">Hi</h3>');
    assert.deepEqual(blocks.map(block => [block.type, block.markup]), [
        ['summary', 'Logs'], ['paragraph', 'body'], ['heading', 'Hi'],
    ]);
});

test('leaves no empty paragraph for lines holding only HTML tags', () => {
    const blocks = parseMarkdown('<details><summary>Log</summary><p>\n\n<blockquote>\n\n## 1.0\n<span></span>\n</blockquote>');
    assert.deepEqual(blocks.map(block => [block.type, block.markup]), [
        ['paragraph', 'Log'], ['heading', '1.0'],
    ]);
});

test('cuts very long bodies and reports the cut', () => {
    const blocks = parseMarkdown('word '.repeat(50), {maxCharacters: 20});
    assert.equal(blocks.at(-1).type, 'truncated');
    assert.deepEqual(parseMarkdown(''), []);
    assert.deepEqual(parseMarkdown(null), []);
});
