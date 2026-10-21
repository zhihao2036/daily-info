import type { ItemVersion } from '../domain/contracts';

/** Remove page chrome before ranking; evidence is still checked against the immutable original. */
export function articleText(version: ItemVersion): string {
  let body = version.bodyText;
  if (new URL(version.canonicalUrl).hostname === 'huggingface.co' && body.startsWith('Back to Articles') && body.includes('Upvote')) {
    const lines = body.split('\n');
    const metadataEnd = lines.findIndex((line) => /\bUpvote\b/.test(line));
    if (metadataEnd >= 0) body = lines.slice(metadataEnd + 1).join('\n');
  }
  return body.replace(/<[^>]*>/g, ' ')
    .split(/\n(?:Community|Discussion|Join the discussion|Comment ·|Tap or paste here to upload)\b/)[0]!.trim();
}

export function sharesTopic(versions: ItemVersion[]): boolean {
  const generic = new Set(['the','and','that','this','with','from','for','are','was','has','have','will','its','their','our','new',
    'model','models','agent','agents','release','update','today','now','they','can','more','about','which','into','been','also']);
  const words = versions.map(version => new Set((`${version.title} ${articleText(version).slice(0, 2400)}`.toLowerCase()
    .match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter(word => !generic.has(word))));
  return words.length > 0 && [...words[0]!].filter(word => words.every(set => set.has(word))).length >= 2;
}

export function evidenceSnippets(version: ItemVersion): string[] {
  const paragraphs = articleText(version).split(/\n\s*\n|(?<=[.!?。])\s+(?=[A-Z\p{Lo}])/u)
    .map((text) => text.normalize('NFKC').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 20 && !/^(?:Back to Articles|Share|Read AI-generated summary|In this article|By\b|Published\b)/i.test(text));
  return paragraphs.slice(0, 12).map((text) => [...text].slice(0, 240).join(''));
}
