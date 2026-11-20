/**
 * Builds the files for a submission, following the official guide ("Make the source readable"):
 *  - working.csv: the inputs and working of a calculation, when there is one
 *  - the original document (PDF/CSV/TXT/DOC/DOCX), downloaded from its public link, when the judge
 *    may not be able to open the link or the link is itself a document. "A copy of an online record
 *    counts only together with a link to the original": the link is always sent too.
 * Limits from config/rules.json: file count, total bytes, allowed types, 8 items per submission.
 * The type is detected from the content (as the API does), not trusted from headers or names.
 */
import { rules } from "../config.js";
import type { Attachment } from "../types.js";
import { info } from "./log.js";

const DOC_EXT = /\.(pdf|csv|txt|docx?)(\?|#|$)/i;

function sniff(buf: Uint8Array, headerType: string): string | null {
  const head = Buffer.from(buf.subarray(0, 8)).toString("latin1");
  if (head.startsWith("%PDF")) return "application/pdf";
  if (head.startsWith("PK")) return headerType.includes("wordprocessingml") ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : null;
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return headerType.includes("msword") ? "application/msword" : null;
  if (headerType.startsWith("text/csv")) return "text/csv";
  if (headerType.startsWith("text/plain")) return "text/plain";
  return null; // HTML pages and anything else are not attached
}

async function download(url: string, budget: number): Promise<Attachment | null> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "User-Agent": "Mozilla/5.0 (evidence-agent; public-record copy)" } });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len && len > budget) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > budget) return null;
    const type = sniff(buf, res.headers.get("content-type") ?? "");
    if (!type || !rules.allowedFileTypes.includes(type)) return null;
    const base = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? "source";
    const ext = { "application/pdf": ".pdf", "text/csv": ".csv", "text/plain": ".txt", "application/msword": ".doc" }[type] ?? ".docx";
    return { name: (base.replace(/[^\w.-]/g, "_").replace(/\.[^.]*$/, "") || "source") + ext, type, data: buf };
  } catch {
    return null;
  }
}

export async function buildAttachments(o: { workingCsv: string; mainSource: string | undefined; sourceMayBeUnreadable: boolean; links: number }): Promise<Attachment[]> {
  const files: Attachment[] = [];
  let budget = rules.maxFileBytesTotal;
  const room = () => Math.min(rules.maxFilesPerSubmission, rules.maxItemsPerSubmission - 1 - o.links) - files.length;

  const csv = o.workingCsv.trim();
  if (csv && csv.includes("\n") && room() > 0) {
    const data = new TextEncoder().encode(csv + "\n");
    files.push({ name: "working.csv", type: "text/csv", data });
    budget -= data.byteLength;
  }
  if (o.mainSource && room() > 0 && (o.sourceMayBeUnreadable || DOC_EXT.test(o.mainSource))) {
    const doc = await download(o.mainSource, budget);
    if (doc) {
      files.push(doc);
      info(`attaching ${doc.name} (${Math.round(doc.data.byteLength / 1024)} KB) copied from ${o.mainSource}`);
    }
  }
  return files;
}

/** For the SDK: multipart files need a name, so use File (a Blob with a filename). */
export const toFiles = (a: Attachment[]) => a.map((f) => new File([Buffer.from(f.data)], f.name, { type: f.type }));
