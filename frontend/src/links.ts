/**
 * Share-link formats, shared by the upload page, "My files" and the admin list.
 *
 * Kept in one place because these three used to disagree: the upload page
 * offered five formats, the other two only ever copied the player URL, and the
 * HTML snippet emitted a <video> tag even for images.
 */
import { siteBase } from './api'

export type LinkFormat = 'player' | 'direct' | 'download' | 'markdown' | 'html' | 'iframe'

export const LINK_FORMATS: { key: LinkFormat; label: string }[] = [
  { key: 'player', label: 'tab.player' },
  { key: 'direct', label: 'tab.direct' },
  { key: 'download', label: 'tab.download' },
  { key: 'markdown', label: 'tab.markdown' },
  { key: 'html', label: 'tab.html' },
  { key: 'iframe', label: 'tab.iframe' },
]

/** The minimum an item needs to expose for links to be built from it. */
export interface Linkable {
  name: string
  orig?: string
  kind?: string
  status?: string
  thumb?: string
  url?: string
  player?: string
}

export function linkFor(v: Linkable, format: LinkFormat): string {
  const o = siteBase()
  const direct = o + (v.url || `/v/${v.name}`)
  const player = o + (v.player || `/p/${v.name}`)
  const poster = o + (v.thumb || `/t/${v.name}`)
  const title = v.orig || v.name
  const isImage = v.kind === 'image'
  // a thumbnail only exists once the pipeline has run
  const hasPoster = !!v.thumb && v.status !== 'processing'

  switch (format) {
    case 'player': return player
    case 'direct': return direct
    case 'download': return o + `/d/${v.name}`
    case 'markdown': return isImage ? `![${title}](${direct})` : `[${title}](${player})`
    case 'html': return isImage
      ? `<img src="${direct}" alt="${title}" style="max-width:100%">`
      : hasPoster
        ? `<video src="${direct}" poster="${poster}" controls style="max-width:100%"></video>`
        : `<video src="${direct}" controls style="max-width:100%"></video>`
    case 'iframe': return `<iframe src="${player}" width="640" height="360" frameborder="0" allowfullscreen></iframe>`
  }
  return ''
}
