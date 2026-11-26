/**
 * Packs a submission's items, following the official guide ("Make the source readable").
 * Since 2026-11-23 a submission holds at most rules.maxItemsPerSubmission (3) items: the note, each
 * link and each file count as 1, and a 4th is refused with 400. We always send the note and the main
 * link ("a copy of an online record counts only together with a link to the original"). Any slot
 * left goes, in this order, to:
 *  1. a copy of the main source when the judge may not be able to open it (the official remedy
 *     for an Unverifiable verdict: "send it with the document attached and the original linked")
 *  2. working.csv: the inputs and working of a calculation
 *  3. a copy of the main source when it is itself a document (PDF, spreadsheet)
 *  4. further source links
 * A calculation that gets no slot of its own goes into the note ("put the key lines in the note
 * itself"), so the working is never lost.
 * File types are detected from the content (as the API does), not trusted from headers or names.
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

export interface Packed {
  links: string[];
  files: Attachment[];
  /** The working CSV when it got no file slot; the caller appends it to the note. */
  workingForNote: string;
}

export async function packItems(o: { sourceUrls: string[]; workingCsv: string; sourceMayBeUnreadable: boolean; download: boolean }): Promise<Packed> {
  const main = o.sourceUrls[0];
  const links = main ? [main] : [];
  const files: Attachment[] = [];
  let budget = rules.maxFileBytesTotal;
  const left = () => rules.maxItemsPerSubmission - 1 /* note */ - links.length - files.length;
  const fileRoom = () => left() > 0 && files.length < rules.maxFilesPerSubmission;

  const csv = o.workingCsv.trim();
  const hasCsv = csv.includes("\n");
  let csvAttached = false;
  const addCsv = () => {
    csvAttached = true;
    const data = new TextEncoder().encode(csv + "\n");
    files.push({ name: "working.csv", type: "text/csv", data });
    budget -= data.byteLength;
  };
  const addCopy = async () => {
    const doc = await download(main!, budget);
    if (!doc) return;
    files.push(doc);
    budget -= doc.data.byteLength;
    info(`attaching ${doc.name} (${Math.round(doc.data.byteLength / 1024)} KB) copied from ${main}`);
  };

  const isDoc = !!main && DOC_EXT.test(main);
  let copied = false;
  if (o.download && main && o.sourceMayBeUnreadable && fileRoom()) { await addCopy(); copied = files.length > 0; }
  if (hasCsv && fileRoom()) addCsv();
  if (o.download && main && isDoc && !copied && fileRoom()) await addCopy();
  for (const url of o.sourceUrls.slice(1)) {
    if (left() <= 0 || links.length >= rules.maxLinksPerSubmission) break;
    if (!links.includes(url)) links.push(url);
  }

  if (hasCsv && !csvAttached) info("no item slot left for working.csv; the working goes into the note");
  return { links, files, workingForNote: hasCsv && !csvAttached ? csv : "" };
}

/** For the SDK: multipart files need a name, so use File (a Blob with a filename). */
export const toFiles = (a: Attachment[]) => a.map((f) => new File([Buffer.from(f.data)], f.name, { type: f.type }));
