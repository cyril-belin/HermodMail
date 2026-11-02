/**
 * Minimal, injection-safe Markdown renderer for AI-generated text.
 *
 * Builds the DOM directly with createElement/textContent — no v-html and no
 * sanitizer to bypass: model output can never become markup, so no crafted
 * token inside an AI summary can inject HTML. Covers the constructs Gemini
 * actually emits: headings, bullet/numbered lists, bold, italic, inline code,
 * horizontal rules, paragraphs and preserved line breaks.
 */

const INLINE_RE = /(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g

function addInline(parent: HTMLElement, text: string): void {
  let last = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)))
    if (m[2] !== undefined) {
      const b = document.createElement('strong')
      b.textContent = m[2]
      parent.appendChild(b)
    } else if (m[3] !== undefined) {
      const em = document.createElement('em')
      em.textContent = m[3]
      parent.appendChild(em)
    } else if (m[4] !== undefined) {
      const code = document.createElement('code')
      code.textContent = m[4]
      parent.appendChild(code)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)))
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function appendParagraphLine(paragraph: HTMLElement, line: string, first: boolean): void {
  if (!first) paragraph.appendChild(document.createElement('br'))
  if (line) addInline(paragraph, line)
}

/** Render a Markdown string into a detached, safe DOM element. */
export function renderMarkdown(md: string): HTMLElement {
  const root = document.createElement('div')
  const lines = md.replace(/\r\n/g, '\n').split('\n')

  let paragraph: HTMLElement | null = null
  let list: HTMLElement | null = null
  let paragraphLines = 0

  const closeParagraph = () => {
    paragraph = null
    paragraphLines = 0
  }
  const closeList = () => {
    list = null
  }

  for (const line of lines) {
    if (isBlank(line)) {
      closeParagraph()
      closeList()
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeParagraph()
      closeList()
      const level = Math.min(heading[1]!.length + 2, 6) // h3…h6 inside a panel
      const h = document.createElement(`h${level}`)
      addInline(h, heading[2]!)
      root.appendChild(h)
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeParagraph()
      closeList()
      root.appendChild(document.createElement('hr'))
      continue
    }

    const bullet = line.match(/^\s*[-*•]\s+(.*)$/)
    if (bullet) {
      closeParagraph()
      if (!list || list.tagName !== 'UL') {
        list = document.createElement('ul')
        root.appendChild(list)
      }
      const li = document.createElement('li')
      addInline(li, bullet[1]!)
      list.appendChild(li)
      continue
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ordered) {
      closeParagraph()
      if (!list || list.tagName !== 'OL') {
        list = document.createElement('ol')
        root.appendChild(list)
      }
      const li = document.createElement('li')
      addInline(li, ordered[1]!)
      list.appendChild(li)
      continue
    }

    // Regular text: consecutive non-blank lines form one paragraph whose
    // internal newlines are preserved as <br>.
    if (!paragraph) {
      paragraph = document.createElement('p')
      root.appendChild(paragraph)
    }
    appendParagraphLine(paragraph, line, paragraphLines === 0)
    paragraphLines += 1
  }

  return root
}
