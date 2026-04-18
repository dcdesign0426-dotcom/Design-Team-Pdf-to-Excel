/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import * as XLSX from 'xlsx';

import { 
  FileText, 
  Upload, 
  Table as TableIcon, 
  Download, 
  Copy, 
  Check, 
  AlertCircle,
  Loader2,
  ChevronRight,
  Database,
  FileJson,
  FileSpreadsheet
} from 'lucide-react';
import { cn } from './lib/utils';

// --- Types ---

interface TableData {
  table_id: string;
  confidence: number;
  columns: string[];
  rows: (string | null)[][];
}

interface ExtractionResult {
  document_name: string;
  total_tables: number;
  tables: TableData[];
}

// --- Constants ---

const SYSTEM_INSTRUCTION = `You are an advanced AI-powered document intelligence system specialized in extracting structured tabular data from complex and inconsistent PDF files.

Your task is to analyze the uploaded PDF and extract ALL tabular data across ALL pages with maximum structural accuracy.

### STEP 1: DOCUMENT UNDERSTANDING & METADATA
* Analyze the full document page by page
* Detect all tables using visual and structural cues (grid lines, spacing, alignment)
* **CRITICAL: Also identify logical "Metadata Tables"**. Many documents contain important information in the header/footer (e.g., PO Number, Department, Section, Style, Supplier, Total Units). 
* **Horizontal Metadata Structure**: The logical "Metadata Table" (e.g., "Header_Information") MUST be structured with each unique attribute as a COLUMN and the data as a single ROW. Do NOT use a "Field" and "Value" column structure. Each attribute name (e.g., "Department", "Supplier ID") should be a header.
* **"NICE LABEL" Primary Table**: The main product/item detail table MUST be extracted with the table_id "NICE LABEL". It MUST follow a specific column structure to support external labeling software.
* Distinguish tables from plain text blocks
* Identify continuation tables across pages

### STEP 2: TABLE DETECTION & SEGMENTATION
For each detected table:
* Assign a descriptive ID based on the table's title or caption in the document (e.g., "Invoice Details", "Employee List", "Purchase Order Metadata"). If no title is found, use Table_1, Table_2, etc.
* Detect table boundaries precisely
* Merge multi-page tables into a single logical table
* Remove repeated headers across pages

### STEP 3: STRUCTURE NORMALIZATION
For each table:
* Identify column headers
* If headers are missing → infer meaningful column names
* Ensure all rows align with correct columns
* Handle merged cells: Propagate values logically across rows/columns
* Normalize inconsistent column counts

### STEP 4: DATA CLEANING & VALUE ISOLATION
* Trim extra spaces, line breaks, and special characters
* **ID Portion Extraction & Padding**: For metadata fields that combine a numerical ID and a descriptive Name (e.g., "Department: 6 - Mens Clothing"), extract ONLY the numerical ID portion. 
* **Zero Padding**: If a numerical ID for Department, Section, or Subsection is a single digit, pad it with a leading zero (e.g., "6" becomes "06", "5" becomes "05").
* **"DSS" Merged Column**: In the "Header_Information" table, add a new column at the end named "DSS". The value for this column MUST be a concatenation of the padded Department, Section, and Subsection values, separated by hyphens (e.g., if Dept=06, Sect=24, SubSect=05, then DSS="06-24-05").
* **"NICE LABEL" Column Mapping**: The "NICE LABEL" table must contain the following columns in order:
    1.  **DSS**: The DSS value from the header, repeated for every row.
    2.  **STYLE**: Product code/Style ORIN.
    3.  **SKU ORIN**: The SKU identifier.
    4.  **BARCODE**: The numerical barcode.
    5.  **SIZE**: The size variant (e.g., XS, S, M, L).
    6.  **KIMBALL**: The Kimball number.
    7.  **COLOR**: The base color name.
    8.  **SUPPLIER ID**: The numerical supplier ID.
    9.  **EUR/KWD**, **AED/PLN**, **CZK/QAR**, **BHD/RON**: Local currency prices.
    10. **Section**: MUST be formatted as "Section: [DSS_Value]" (e.g., "Section: 06-90-05").
    11. **Colour**: MUST be formatted as "Col: [COLOR_Value]" (e.g., "Col: CHARCOAL").
    12. **Barcode2**: MUST be formatted as "Barcode: [BARCODE_Value]" (e.g., "Barcode: 5397362149436").
    13. **PRICE**, **KWD**, **AED**: Final pricing columns.
* **Exclude Summary Rows**: DO NOT include rows that represent totals or subtotals (e.g., rows containing the word "Total", "Grand Total", or "Subtotal"). The goal is to extract only the raw data lines.
* Normalize numbers: Separate units if possible ("12 pcs" → "12", "pcs")
* Standardize date formats if detected
* Remove duplicate rows if clearly repeated
* Preserve original meaning of data

### STEP 5: OCR HANDLING (IF NEEDED)
If the PDF contains scanned images, perform OCR-based extraction and reconstruct tables based on spatial alignment.

### STEP 6: CONFIDENCE & ERROR HANDLING
For each table:
* Provide a confidence score (0–100)
* If structure is uncertain: Still return best possible structured output and mark low confidence

### STEP 7: OUTPUT FORMAT (STRICT JSON ONLY)
Return ONLY valid JSON in the following format:
{
  "document_name": "uploaded_file_name.pdf",
  "total_tables": number,
  "tables": [
    {
      "table_id": "Table_1",
      "confidence": 95,
      "columns": ["Column1", "Column2", "Column3"],
      "rows": [
        ["data1", "data2", "data3"],
        ["data4", "data5", "data6"]
      ]
    }
  ]
}

### CRITICAL RULES
* **OMIT NOTHING**: You MUST extract every single table found in the document. Do not skip any data.
* **INVENTORY**: If you find 5 tables, you must return all 5 tables. The "NICE LABEL" table is an ADDITIONAL structural representation; you should still include the original item table if it exists.
* DO NOT return explanation
* DO NOT include markdown
* DO NOT include comments
* ONLY return valid JSON
* Ensure no missing brackets or syntax errors
* All tables must be included`;

// --- Components ---

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [result, setResult] = useState<ExtractionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [activeTab, setActiveTab] = useState<'preview' | 'json'>('preview');

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const selectedFile = acceptedFiles[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setError(null);
      setResult(null);
    } else {
      setError('Please upload a valid PDF file.');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false
  } as any);

  const [manualApiKey, setManualApiKey] = useState('');

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        const base64String = reader.result as string;
        resolve(base64String.split(',')[1]);
      };
      reader.onerror = (error) => reject(error);
    });
  };

  const handleExtract = async () => {
    if (!file) return;

    setIsExtracting(true);
    setLoadingStatus('Preparing document...');
    setError(null);

    try {
      // Use manual key if provided, otherwise check environment
      const apiKey = manualApiKey || process.env.GEMINI_API_KEY;
      
      const isPlaceholder = !apiKey || 
                           apiKey === 'MY_GEMINI_API_KEY' || 
                           apiKey === '' || 
                           apiKey === 'undefined' || 
                           apiKey.length < 10;

      if (isPlaceholder) {
        setLoadingStatus('Entering Demo Mode (No API Key found)...');
        console.warn("API Key missing. Falling back to Demo Mode.");
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const demoResult: ExtractionResult = {
          document_name: file.name,
          total_tables: 2,
          tables: [
            {
              table_id: "Header_Information",
              confidence: 99,
              columns: ["PO Number", "Department", "Section", "Subsection", "Supplier ID", "Total Units", "DSS"],
              rows: [
                ["1251347", "06", "24", "05", "84081", "35,690", "06-24-05"]
              ]
            },
            {
              table_id: "NICE LABEL",
              confidence: 98,
              columns: ["DSS", "STYLE", "SKU ORIN", "BARCODE", "SIZE", "KIMBALL", "COLOR", "SUPPLIER ID", "EUR/KWD", "AED/PLN", "CZK/QAR", "BHD/RON", "Section", "Colour", "Barcode2", "PRICE", "KWD", "AED"],
              rows: [
                ["06-90-05", "991184628", "212154928", "5397362149436", "XS", "4316401", "CHARCOAL", "43001", "€ 16.00", "60.00 PLN", "365.00 Kč", "70.00 LEI", "Section: 06-90-05", "Col: CHARCOAL", "Barcode: 5397362149436", "$30", "KWD 20.500", "AED 120.00"],
                ["06-90-05", "991184628", "212154929", "5397362149443", "S", "4316402", "CHARCOAL", "43001", "€ 16.00", "60.00 PLN", "365.00 Kč", "70.00 LEI", "Section: 06-90-05", "Col: CHARCOAL", "Barcode: 5397362149443", "$30", "KWD 20.500", "AED 120.00"]
              ]
            }
          ]
        };
        setResult(demoResult);
        setError("⚠️ Extraction Limited: No Gemini API Key found. To use live AI extraction, please provide an API key in the Secrets panel or the field below.");
        return;
      }

      setLoadingStatus('Converting document to AI format...');
      const ai = new GoogleGenAI({ apiKey });
      const base64Data = await fileToBase64(file);

      setLoadingStatus('AI is analyzing structure and extracting data (this may take up to 30s)...');
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              { text: `Extract tables from this PDF: ${file.name}` },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: base64Data
                }
              }
            ]
          }
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: "application/json"
        }
      });

      const text = response.text;
      if (!text) throw new Error("No response from AI");

      const parsedResult = JSON.parse(text) as ExtractionResult;
      setResult(parsedResult);
    } catch (err) {
      console.error("Extraction error:", err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred during extraction.");
    } finally {
      setIsExtracting(false);
    }
  };

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${result.document_name.replace('.pdf', '')}_extracted.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadExcel = () => {
    if (!result) return;
    
    const wb = XLSX.utils.book_new();
    
    (result?.tables || []).forEach((table) => {
      if (!table.columns || !table.rows) return;

      // Create data array: headers + rows
      const data = [table.columns, ...table.rows];
      const ws = XLSX.utils.aoa_to_sheet(data);

      // Estimated column widths
      const colWidths = (table.columns || []).map((col, colIdx) => {
        let maxLen = (col || "").toString().length;
        (table.rows || []).forEach(row => {
          if (!row) return;
          const val = row[colIdx];
          if (val !== null && val !== undefined) {
            maxLen = Math.max(maxLen, val.toString().length);
          }
        });
        return { wch: maxLen + 2 };
      });
      ws['!cols'] = colWidths;

      // Clean sheet name (31 chars max, no forbidden chars)
      const safeName = (table.table_id || 'Sheet')
        .replace(/[\[\]\*\?\/\\]/g, '') // remove forbidden chars :\/?*[]
        .substring(0, 31) || `Sheet${Math.random().toString(36).substring(7)}`;

      XLSX.utils.book_append_sheet(wb, ws, safeName);
    });
    
    XLSX.writeFile(wb, `${result.document_name.replace('.pdf', '')}_extracted.xlsx`);
  };

  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden">
      {/* Background Grid */}
      <div className="absolute inset-0 data-grid pointer-events-none" />

      {/* Header */}
      <header className="border-b border-line p-6 flex justify-between items-center bg-white z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary text-primary-foreground flex items-center justify-center rounded-md shadow-sm">
            <Database size={24} />
          </div>
          <div>
            <h1 className="font-bold text-xl tracking-tight text-ink">TabulaExtract AI</h1>
            <p className="text-[10px] font-mono text-primary uppercase tracking-widest font-semibold">Document Intelligence System v1.1</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] font-mono opacity-50 uppercase">System Status</span>
            <span className="text-xs font-medium flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Operational
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col md:flex-row z-10">
        {/* Left Panel: Upload & Controls */}
        <div className="w-full md:w-1/3 border-r border-line p-8 flex flex-col gap-8 bg-bg/50">
          <section>
            <h2 className="font-serif italic text-sm opacity-50 uppercase mb-4">01. Document Input</h2>
            <div 
              {...getRootProps()} 
              className={cn(
                "border-2 border-dashed border-line/20 rounded-lg p-8 transition-all cursor-pointer flex flex-col items-center justify-center gap-4 text-center",
                isDragActive ? "bg-ink/5 border-ink/40" : "hover:bg-ink/5",
                file ? "border-ink/40 bg-ink/5" : ""
              )}
            >
              <input {...getInputProps()} />
              <div className="w-12 h-12 rounded-full bg-ink/5 flex items-center justify-center">
                {file ? <FileText className="text-ink" /> : <Upload className="text-ink/40" />}
              </div>
              <div>
                <p className="font-medium text-sm">
                  {file ? file.name : "Drop PDF here or click to browse"}
                </p>
                <p className="text-xs opacity-50 mt-1">
                  {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : "Maximum file size: 20MB"}
                </p>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="font-serif italic text-sm opacity-50 uppercase">02. API Key Configuration</h2>
            <div className="flex flex-col gap-2">
              <label className="text-[10px] font-mono uppercase opacity-50">Local API Key</label>
              <input 
                type="password"
                value={manualApiKey}
                onChange={(e) => setManualApiKey(e.target.value)}
                placeholder="Paste Gemini API Key here..."
                className="w-full p-3 bg-white border border-line rounded-md text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <p className="text-[9px] opacity-40 italic">
                {manualApiKey ? "Key provided manually." : "Using system secret (if available) or demo mode."}
              </p>
            </div>
            <div className="p-3 bg-amber-50 border border-amber-100 rounded text-[10px] leading-relaxed text-amber-700">
              <strong>Note on "Publishing":</strong> If you share or download this project, the API secret stays in AI Studio. 
              External users must provide their own key here to process new documents.
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="font-serif italic text-sm opacity-50 uppercase">03. Extraction Engine</h2>
            <button
              onClick={handleExtract}
              disabled={!file || isExtracting}
              className={cn(
                "w-full py-4 rounded-md font-bold uppercase tracking-widest text-sm transition-all flex items-center justify-center gap-2 shadow-sm",
                !file || isExtracting 
                  ? "bg-slate-200 text-slate-400 cursor-not-allowed" 
                  : "bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]"
              )}
            >
              {isExtracting ? (
                <div className="flex flex-col items-center gap-1">
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} />
                    <span>Processing...</span>
                  </div>
                  <span className="text-[9px] font-mono normal-case font-normal opacity-70 tracking-normal">{loadingStatus}</span>
                </div>
              ) : (
                <>
                  Extract Tabular Data
                  <ChevronRight size={18} />
                </>
              )}
            </button>

            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={cn(
                  "p-4 border rounded-md flex gap-3",
                  error.includes("Demo Mode") || error.includes("API Key Not Found")
                    ? "bg-blue-50 border-blue-200 text-blue-700" 
                    : "bg-red-50 border-red-200 text-red-600"
                )}
              >
                <AlertCircle size={18} className="shrink-0" />
                <p className="text-xs leading-relaxed">{error}</p>
              </motion.div>
            )}
          </section>

          <section className="mt-auto">
            <div className="p-4 border border-line/10 rounded-sm bg-ink/[0.02]">
              <h3 className="text-[10px] font-mono opacity-50 uppercase mb-2">Extraction Rules</h3>
              <ul className="text-[10px] font-mono flex flex-col gap-1.5 opacity-70">
                <li className="flex gap-2">• Multi-page table merging</li>
                <li className="flex gap-2">• Structural normalization</li>
                <li className="flex gap-2">• OCR-based reconstruction</li>
                <li className="flex gap-2">• Unit separation & cleaning</li>
              </ul>
            </div>
          </section>
        </div>

        {/* Right Panel: Results */}
        <div className="flex-1 flex flex-col min-h-[500px]">
          {!result && !isExtracting ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center opacity-20">
              <TableIcon size={64} strokeWidth={1} />
              <p className="mt-4 font-serif italic text-lg">Awaiting document processing...</p>
            </div>
          ) : isExtracting ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
              <div className="relative">
                <Loader2 className="animate-spin text-ink" size={48} strokeWidth={1} />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-1 h-1 bg-ink rounded-full" />
                </div>
              </div>
              <p className="mt-6 font-serif italic text-lg">{loadingStatus || "Analyzing document structure..."}</p>
              <p className="mt-2 text-xs font-mono opacity-50 uppercase tracking-widest">Please stay on this page</p>
              <div className="mt-4 w-48 h-1 bg-ink/10 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-ink"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 15, ease: "linear" }}
                />
              </div>
            </div>
          ) : (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex-1 flex flex-col"
            >
              {/* Result Header */}
              <div className="border-b border-line p-4 flex justify-between items-center bg-bg/50 sticky top-0 z-20 backdrop-blur-sm">
                <div className="flex gap-1">
                  <button 
                    onClick={() => setActiveTab('preview')}
                    className={cn(
                      "px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-sm transition-all",
                      activeTab === 'preview' ? "bg-ink text-bg" : "hover:bg-ink/5"
                    )}
                  >
                    Table Preview
                  </button>
                  <button 
                    onClick={() => setActiveTab('json')}
                    className={cn(
                      "px-4 py-2 text-xs font-bold uppercase tracking-wider rounded-sm transition-all",
                      activeTab === 'json' ? "bg-ink text-bg" : "hover:bg-ink/5"
                    )}
                  >
                    Raw JSON
                  </button>
                </div>
                <div className="flex gap-2">
                  <button 
                    onClick={handleCopy}
                    className="p-2 hover:bg-slate-100 rounded-md transition-all relative group text-slate-600"
                    title="Copy JSON"
                  >
                    {copySuccess ? <Check size={18} className="text-green-600" /> : <Copy size={18} />}
                  </button>
                  <button 
                    onClick={handleDownloadExcel}
                    className="p-2 hover:bg-blue-50 text-primary rounded-md transition-all relative group flex items-center gap-2 border border-blue-100"
                    title="Download Excel"
                  >
                    <FileSpreadsheet size={18} />
                    <span className="text-[10px] font-bold uppercase">Excel</span>
                  </button>
                  <button 
                    onClick={handleDownload}
                    className="p-2 hover:bg-slate-100 text-slate-600 rounded-md transition-all relative group flex items-center gap-2 border border-slate-200"
                    title="Download JSON"
                  >
                    <Download size={18} />
                    <span className="text-[10px] font-bold uppercase">JSON</span>
                  </button>
                </div>
              </div>

              {/* Result Content */}
              <div className="flex-1 overflow-auto p-8">
                <AnimatePresence mode="wait">
                  {activeTab === 'preview' ? (
                    <motion.div 
                      key="preview"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="flex flex-col gap-12"
                    >
                      {(result?.tables || []).map((table, idx) => (
                        <div key={table.table_id || idx} className="flex flex-col gap-4">
                          <div className="flex justify-between items-end border-b border-line/20 pb-2">
                            <div>
                              <h3 className="font-bold uppercase tracking-tight">{table.table_id || `Table ${idx + 1}`}</h3>
                              <p className="text-[10px] font-mono opacity-50 uppercase">Extracted Table Structure</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] font-mono opacity-50 uppercase">Confidence</span>
                              <div className="flex items-center gap-1.5">
                                <div className="w-16 h-1.5 bg-ink/10 rounded-full overflow-hidden">
                                  <div 
                                    className={cn(
                                      "h-full rounded-full",
                                      (table.confidence || 0) > 80 ? "bg-green-500" : (table.confidence || 0) > 50 ? "bg-yellow-500" : "bg-red-500"
                                    )}
                                    style={{ width: `${table.confidence || 0}%` }}
                                  />
                                </div>
                                <span className="text-xs font-mono font-bold">{table.confidence || 0}%</span>
                              </div>
                            </div>
                          </div>
                          
                          <div className="overflow-x-auto border border-line/10 rounded-sm shadow-sm">
                            <table className="w-full text-left border-collapse">
                              <thead>
                                <tr className="bg-ink/[0.02]">
                                  {(table.columns || []).map((col, i) => (
                                    <th key={i} className="p-3 text-[11px] font-serif italic border-b border-line/10 opacity-60 uppercase tracking-wider">
                                      {col}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(table.rows || []).map((row, i) => (
                                  <tr key={i} className="hover:bg-ink/[0.02] transition-colors border-b border-line/[0.05] last:border-0">
                                    {(row || []).map((cell, j) => (
                                      <td key={j} className="p-3 text-xs font-mono border-r border-line/[0.05] last:border-r-0">
                                        {cell === null ? <span className="opacity-20 italic">null</span> : cell}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="json"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="h-full"
                    >
                      <pre className="p-6 bg-ink text-bg/90 rounded-sm font-mono text-xs overflow-auto h-full leading-relaxed selection:bg-bg/20">
                        {JSON.stringify(result, null, 2)}
                      </pre>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </div>
      </main>

      {/* Footer Info */}
      <footer className="border-t border-line p-4 bg-bg/80 backdrop-blur-sm z-10 flex justify-between items-center">
        <div className="flex gap-6">
          <div className="flex items-center gap-2">
            <FileJson size={14} className="opacity-40" />
            <span className="text-[10px] font-mono opacity-50 uppercase">Output: JSON v1.1</span>
          </div>
          <div className="flex items-center gap-2">
            <TableIcon size={14} className="opacity-40" />
            <span className="text-[10px] font-mono opacity-50 uppercase">Engine: Gemini 3 Flash</span>
          </div>
        </div>
        <div className="text-[10px] font-mono opacity-30 uppercase">
          &copy; 2026 TabulaExtract Intelligence Systems
        </div>
      </footer>
    </div>
  );
}
