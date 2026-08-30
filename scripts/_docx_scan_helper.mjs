/** flattenDocxXml — the v3.9.1 table-aware token scanner extracted verbatim
 *  from fileParser.ts docxToText so tests can drive it with synthetic XML. */
export function flattenDocxXml(xml) {
  const TOKEN_RE = /<\/w:p>|<\/w:tc>|<\/w:tr>|<\/w:tbl>|<w:tbl>|<w:tbl\s[^>]*>|<w:tab[^>]*\/>|<w:br[^>]*\/>/gi
  let out = ''
  let depth = 0
  let last = 0
  for (const m of xml.matchAll(TOKEN_RE)) {
    out += xml.slice(last, m.index)
    last = (m.index ?? 0) + m[0].length
    const tok = m[0].toLowerCase()
    if (tok === '<w:tbl>' || (tok.startsWith('<w:tbl ') && !tok.endsWith('/>'))) depth++
    else if (tok === '</w:tbl>') depth = Math.max(0, depth - 1)
    else if (tok === '</w:tc>') out += ' | '
    else if (tok === '</w:tr>') out += '\n'
    else if (tok === '</w:p>') out += depth > 0 ? ' ' : '\n'
    else if (tok.startsWith('<w:tab')) out += depth > 0 ? ' ' : '\t'
    else if (tok.startsWith('<w:br')) out += depth > 0 ? ' ' : '\n'
  }
  out += xml.slice(last)
  let text = out.replace(/<[^>]+>/g, '')
  text = text.replace(/[ \t]*\|[ \t]*\n/g, '\n')
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return text
}
