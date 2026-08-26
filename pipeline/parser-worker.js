// parser-worker.js
// Web Worker for file parsing (PDF, DOCX, XLSX, CSV)

importScripts(
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js'
);

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
}

self.onmessage = async function(e) {
  const { fileBytes, fileName, ext } = e.data;
  try {
    let resultText = "";
    
    if (ext === 'csv' || ext === 'tsv') {
      resultText = parseCSV(fileBytes, ext);
    } else if (ext === 'xlsx' || ext === 'xls') {
      resultText = parseExcel(fileBytes);
    } else if (ext === 'docx') {
      resultText = await parseDOCX(fileBytes);
    } else if (ext === 'pdf') {
      resultText = await parsePDF(fileBytes);
    } else {
      const decoder = new TextDecoder('utf-8');
      resultText = decoder.decode(fileBytes);
    }

    if (!resultText || !resultText.trim()) {
      throw new Error("Không có dữ liệu phù hợp để đọc.");
    }

    self.postMessage({ success: true, text: resultText, fileName });
  } catch (err) {
    self.postMessage({ success: false, error: err.message, fileName });
  }
};

function parseCSV(arrayBuffer, ext) {
  const decoder = new TextDecoder('utf-8');
  let content = decoder.decode(arrayBuffer);
  
  const delimiter = (ext === 'tsv') ? '\t' : '';
  
  const parsed = Papa.parse(content, {
    delimiter: delimiter,
    header: true,
    skipEmptyLines: true
  });
  
  if (parsed.errors && parsed.errors.length > 0 && parsed.data.length === 0) {
    throw new Error(parsed.errors[0].message);
  }
  
  const rowTexts = [];
  parsed.data.forEach((row, i) => {
    const rowItems = [];
    for (const [k, v] of Object.entries(row)) {
      if (k && v && v.toString().trim()) {
        rowItems.push(`${k}: ${v}`);
      }
    }
    if (rowItems.length > 0) {
      rowTexts.push(`[Dòng ${i + 1}] ` + rowItems.join(" | "));
    }
  });
  
  return rowTexts.join('\n');
}

function parseExcel(arrayBuffer) {
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const textParts = [];
  
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    
    textParts.push(`\n--- Bảng: ${sheetName} ---`);
    let headers = null;
    
    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx];
      const nonEmpty = row.filter(c => c !== null && c.toString().trim() !== "");
      if (!headers && nonEmpty.length > 1) {
        headers = row.map((h, i) => h !== null ? h.toString().trim() : `Column${i}`);
        continue;
      }
      
      if (headers) {
        const rowItems = [];
        for (let i = 0; i < headers.length; i++) {
          const val = row[i];
          if (val !== null && val !== undefined && val.toString().trim() !== "") {
            rowItems.push(`${headers[i]}: ${val}`);
          }
        }
        if (rowItems.length > 0) {
          textParts.push(`[Dòng ${idx + 1}] ` + rowItems.join(" | "));
        }
      }
    }
  });
  
  return textParts.join('\n');
}

async function parseDOCX(arrayBuffer) {
  const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
  return result.value || "";
}

async function parsePDF(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const textParts = [];
  
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    const text = strings.join(" ").replace(/\s+/g, ' ').trim();
    if (text) {
      textParts.push(text);
    }
  }
  
  return textParts.join('\n\n');
}
