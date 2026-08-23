/**
 * Markdown rendering wrapper using marked.js, highlight.js, and KaTeX
 */

let isConfigured = false;

function ensureMarkedConfigured() {
    if (isConfigured) return;
    if (typeof marked === 'undefined') return;

    try {
        const renderer = new marked.Renderer();

        renderer.code = function(code, infostring, escaped) {
            const lang = (infostring || '').match(/\S*/)[0];
            const displayLang = lang || 'code';
            let highlighted;

            if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
                try {
                    highlighted = hljs.highlight(code, { language: lang }).value;
                } catch (e) {
                    highlighted = escapeHtml(code);
                }
            } else {
                // Fast path for untagged / plain text blocks: avoids expensive regex brute force across 190+ languages
                highlighted = escapeHtml(code);
            }

            const encoded = encodeURIComponent(code);
            return `
<div class="code-block-wrapper">
    <div class="code-block-header">
        <span class="code-block-lang">${escapeHtml(displayLang)}</span>
        <button class="code-copy-btn" data-code="${encoded}" type="button" title="Copy code">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
                <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
            </svg>
            <span>Copy</span>
        </button>
    </div>
    <pre><code class="hljs ${lang ? 'language-' + escapeHtml(lang) : ''}">${highlighted}</code></pre>
</div>
`;
        };

        renderer.image = function(href, title, text) {
            const cleanHref = href || '';
            const cleanTitle = title ? `title="${escapeHtml(title)}"` : '';
            const cleanAlt = text ? escapeHtml(text) : 'Image';
            const showCaption = text && text !== 'Image' && !text.startsWith('http');
            return `<div class="chat-image-container">
    <img src="${escapeHtml(cleanHref)}" alt="${cleanAlt}" ${cleanTitle} class="chat-attached-image" loading="lazy" />
    ${showCaption ? `<div class="chat-image-caption">${cleanAlt}</div>` : ''}
</div>`;
        };

        marked.use({
            renderer: renderer,
            breaks: true,
            gfm: true,
            headerIds: false,
            mangle: false
        });
        isConfigured = true;
    } catch (e) {
        console.warn('Failed to configure marked.js custom renderer:', e);
    }
}

/**
 * Preprocess and render LaTeX math using KaTeX
 * @param {string} text
 * @returns {{ processed: string, mathBlocks: string[] }}
 */
function extractAndRenderMath(text) {
    if (typeof katex === 'undefined' || !text) {
        return { processed: text, mathBlocks: [] };
    }

    const mathBlocks = [];

    // 1. Block Math: $$...$$ or \[...\]
    let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, expr) => {
        const id = `%%KATEX_BLOCK_${mathBlocks.length}%%`;
        try {
            const html = katex.renderToString(expr.trim(), {
                displayMode: true,
                throwOnError: false
            });
            mathBlocks.push(html);
            return `\n\n${id}\n\n`;
        } catch (e) {
            return match;
        }
    });

    processed = processed.replace(/\\\[([\s\S]+?)\\\]/g, (match, expr) => {
        const id = `%%KATEX_BLOCK_${mathBlocks.length}%%`;
        try {
            const html = katex.renderToString(expr.trim(), {
                displayMode: true,
                throwOnError: false
            });
            mathBlocks.push(html);
            return `\n\n${id}\n\n`;
        } catch (e) {
            return match;
        }
    });

    // 2. Inline Math: \(...\)
    processed = processed.replace(/\\\(([\s\S]+?)\\\)/g, (match, expr) => {
        const id = `%%KATEX_INLINE_${mathBlocks.length}%%`;
        try {
            const html = katex.renderToString(expr.trim(), {
                displayMode: false,
                throwOnError: false
            });
            mathBlocks.push(html);
            return id;
        } catch (e) {
            return match;
        }
    });

    // 3. Inline Math: $...$ (avoid currency like $100 or escaped \$)
    processed = processed.replace(/(?<!\\|\$)(\$)(?!\$)((?:[^\$\n\\]|\\.)+?)(?<!\\|\$)\1(?!\$)/g, (match, p1, expr) => {
        const trimmed = expr.trim();
        if (!trimmed) return match;
        const id = `%%KATEX_INLINE_${mathBlocks.length}%%`;
        try {
            const html = katex.renderToString(trimmed, {
                displayMode: false,
                throwOnError: false
            });
            mathBlocks.push(html);
            return id;
        } catch (e) {
            return match;
        }
    });

    return { processed, mathBlocks };
}

/**
 * Restore KaTeX rendered HTML placeholders
 * @param {string} html
 * @param {string[]} mathBlocks
 * @returns {string}
 */
function restoreMathBlocks(html, mathBlocks) {
    if (!mathBlocks || mathBlocks.length === 0) return html;
    let result = html;
    for (let i = 0; i < mathBlocks.length; i++) {
        const blockToken = `%%KATEX_BLOCK_${i}%%`;
        const inlineToken = `%%KATEX_INLINE_${i}%%`;
        
        // Replace paragraph-wrapped block token if marked wrapped it in <p>%%KATEX_BLOCK_x%%</p>
        result = result.split(`<p>${blockToken}</p>`).join(mathBlocks[i]);
        result = result.split(blockToken).join(mathBlocks[i]);
        result = result.split(inlineToken).join(mathBlocks[i]);
    }
    return result;
}

/**
 * Render markdown text to HTML with KaTeX support
 * @param {string} text - Markdown text
 * @returns {string} - HTML string
 */
export function renderMarkdown(text) {
    if (!text) {
        return '';
    }

    if (typeof marked !== 'undefined') {
        ensureMarkedConfigured();
        try {
            const { processed, mathBlocks } = extractAndRenderMath(text);
            const parsedHtml = marked.parse(processed);
            const fullHtml = restoreMathBlocks(parsedHtml, mathBlocks);

            if (typeof DOMPurify !== 'undefined') {
                return DOMPurify.sanitize(fullHtml, {
                    ADD_TAGS: [
                        'semantics', 'annotation', 'math', 'mrow', 'mi', 'mo', 'mn', 'msup',
                        'msub', 'mfrac', 'mover', 'munder', 'munderover', 'mspace', 'msqrt',
                        'mroot', 'mtable', 'mtr', 'mtd', 'span', 'svg', 'path', 'g', 'line',
                        'rect', 'circle'
                    ],
                    ADD_ATTR: [
                        'target', 'loading', 'data-code', 'xmlns', 'viewBox', 'aria-hidden',
                        'style', 'd', 'fill', 'stroke', 'stroke-width', 'mathvariant', 'display',
                        'columnalign', 'rowspacing', 'columnspacing'
                    ],
                    FORBID_TAGS: ['script', 'iframe', 'object', 'embed']
                });
            }
            return fullHtml;
        } catch (error) {
            console.error('Markdown rendering error:', error);
        }
    }

    // Fallback to plain text with line breaks and basic escaping
    return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * Escape HTML to prevent XSS (for displaying raw text)
 * @param {string} text - Raw text
 * @returns {string} - Escaped HTML
 */
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

