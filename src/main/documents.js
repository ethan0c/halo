// Pulls plain text out of a resume or job description file, locally.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CHARS = 40_000;

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let text = '';
  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: await fs.readFile(filePath) });
    try {
      const result = await parser.getText();
      text = (result.text || '').replace(/\n-- \d+ of \d+ --\n/g, '\n');
    } finally { await parser.destroy?.(); }
  } else if (ext === '.docx') {
    const mammoth = require('mammoth');
    text = (await mammoth.extractRawText({ path: filePath })).value || '';
  } else if (['.txt', '.md', '.markdown', '.rtf', '.json', '.html', '.htm', ''].includes(ext)) {
    text = await fs.readFile(filePath, 'utf8');
    if (ext === '.html' || ext === '.htm') text = text.replace(/<[^>]+>/g, ' ');
  } else {
    throw new Error(`Unsupported file type "${ext}". Use PDF, DOCX, TXT or Markdown.`);
  }
  text = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('No text found in that file. If it is a scanned PDF, export it as text first.');
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '\n[truncated]';
  return { name: path.basename(filePath), text };
}

module.exports = { extractText };
