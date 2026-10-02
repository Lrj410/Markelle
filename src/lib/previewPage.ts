import { PREVIEW_PAGE_CHARS } from "./files";

export interface PreviewPage {
  text: string;
  page: number;
  pageCount: number;
  fromChar: number;
  toChar: number;
}

/** Slice markdown source into character pages for large-file preview. */
export function slicePreviewPage(
  source: string,
  page: number,
  pageChars = PREVIEW_PAGE_CHARS,
): PreviewPage {
  const len = source.length;
  const pageCount = Math.max(1, Math.ceil(len / pageChars) || 1);
  const safePage = Math.min(Math.max(1, page), pageCount);
  const fromChar = (safePage - 1) * pageChars;
  const toChar = Math.min(len, fromChar + pageChars);
  return {
    text: source.slice(fromChar, toChar),
    page: safePage,
    pageCount,
    fromChar,
    toChar,
  };
}
