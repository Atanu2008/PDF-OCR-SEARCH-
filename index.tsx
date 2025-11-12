import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from '@google/genai';

// FIX: Add type declaration for pdfjsLib to prevent TypeScript errors.
declare const pdfjsLib: any;

const App = () => {
  const [file, setFile] = useState<File | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeSearchTerm, setActiveSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<number[]>([]);
  const [foundMessage, setFoundMessage] = useState('');
  const [pdfDocProxy, setPdfDocProxy] = useState<any | null>(null);


  const pageCanvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useLayoutEffect(() => {
    if (!pdfDocProxy || isLoading) return;

    const renderPages = async () => {
      for (let i = 1; i <= pdfDocProxy.numPages; i++) {
        const page = await pdfDocProxy.getPage(i);
        const canvas = pageCanvasRefs.current[i - 1];
        if (canvas) {
          const viewport = page.getViewport({ scale: 1.5 });
          const context = canvas.getContext('2d');
          if (context) {
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            
            // Highlighting logic
            if (activeSearchTerm && searchResults.includes(i)) {
                context.fillStyle = 'rgba(255, 255, 0, 0.4)'; // Yellow highlight
                const textContent = await page.getTextContent();
                
                let pageText = '';
                const itemPositions: number[] = [];
                textContent.items.forEach((item: any) => {
                    itemPositions.push(pageText.length);
                    pageText += item.str;
                });
                
                const pageTextLower = pageText.toLowerCase();
                const searchTermLower = activeSearchTerm.toLowerCase();
                
                let startIndex = 0;
                while (startIndex < pageTextLower.length) {
                    const matchIndex = pageTextLower.indexOf(searchTermLower, startIndex);
                    if (matchIndex === -1) break;
                    
                    const matchEndIndex = matchIndex + searchTermLower.length;
                    const itemsToHighlightIndices = new Set();

                    for (let j = 0; j < textContent.items.length; j++) {
                        const itemStartIndex = itemPositions[j];
                        const itemEndIndex = itemStartIndex + textContent.items[j].str.length;
                        if (Math.max(itemStartIndex, matchIndex) < Math.min(itemEndIndex, matchEndIndex)) {
                           itemsToHighlightIndices.add(j);
                        }
                    }

                    itemsToHighlightIndices.forEach(index => {
                        const item = textContent.items[index];
                        const tx = pdfjsLib.util.transform(viewport.transform, item.transform);
                        const textHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
                        const width = item.width * viewport.scale;
                        context.fillRect(tx[4], tx[5] - textHeight, width, textHeight);
                    });

                    startIndex = matchEndIndex;
                }
            }
          }
        }
      }
    };

    renderPages().catch(err => {
      console.error("Failed to render PDF pages:", err);
      setError("An error occurred while displaying the PDF preview.");
    });
  }, [pdfDocProxy, isLoading, searchResults, activeSearchTerm]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      resetState();
    } else {
      setError('Please select a valid PDF file.');
      setFile(null);
    }
  };
  
  const resetState = () => {
      setError('');
      setPageTexts([]);
      setTotalPages(0);
      setSearchTerm('');
      setActiveSearchTerm('');
      setSearchResults([]);
      setFoundMessage('');
      setPdfDocProxy(null);
      pageCanvasRefs.current = [];
  }

  const processPdf = async () => {
    if (!file) return;

    setIsLoading(true);
    resetState();

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const model = 'gemini-2.5-flash';

      const fileReader = new FileReader();
      fileReader.readAsArrayBuffer(file);

      fileReader.onload = async (e) => {
        try {
          const typedarray = new Uint8Array(e.target?.result as ArrayBuffer);
          const pdfDoc = await pdfjsLib.getDocument(typedarray).promise;
          setTotalPages(pdfDoc.numPages);
          setPdfDocProxy(pdfDoc);
          pageCanvasRefs.current = Array(pdfDoc.numPages).fill(null);

          const texts: string[] = [];

          for (let i = 1; i <= pdfDoc.numPages; i++) {
            setStatusMessage(`Performing OCR on Page ${i} of ${pdfDoc.numPages}...`);
            const page = await pdfDoc.getPage(i);
            
            // Create a temporary canvas for high-quality image data
            const tempCanvas = document.createElement('canvas');
            const tempContext = tempCanvas.getContext('2d')!;
            const tempViewport = page.getViewport({ scale: 2.0 }); // Higher scale for better OCR
            tempCanvas.height = tempViewport.height;
            tempCanvas.width = tempViewport.width;
            await page.render({ canvasContext: tempContext, viewport: tempViewport }).promise;

            const base64Image = tempCanvas.toDataURL('image/png').split(',')[1];
            
            const imagePart = { inlineData: { mimeType: 'image/png', data: base64Image } };
            const textPart = { text: "Extract all text from this image. The text might be in Bengali. Respond with only the extracted text, maintaining line breaks." };

            const response = await ai.models.generateContent({
                model: model,
                contents: { parts: [imagePart, textPart] },
            });

            texts.push(response.text);
          }
          setPageTexts(texts);
          setStatusMessage('');
        } catch (err) {
          console.error(err);
          setError(`An error occurred while processing the PDF. Please try again. Details: ${err.message}`);
        } finally {
            setIsLoading(false);
        }
      };
    } catch (err) {
      console.error(err);
      setError(`Failed to initialize services. Please check your connection or API key. Details: ${err.message}`);
      setIsLoading(false);
    }
  };

  const handleSearch = () => {
    if (!searchTerm.trim()) {
        setSearchResults([]);
        setFoundMessage('');
        setActiveSearchTerm('');
        return;
    }
    const foundPages = pageTexts.reduce((acc, text, index) => {
        if (text.toLowerCase().includes(searchTerm.toLowerCase())) {
            acc.push(index + 1);
        }
        return acc;
    }, [] as number[]);
    
    setSearchResults(foundPages);
    setActiveSearchTerm(searchTerm);

    if(foundPages.length > 0) {
        setFoundMessage(`Found "${searchTerm}" on pages: ${foundPages.join(', ')}`);
    } else {
        setFoundMessage(`"${searchTerm}" was not found in this document.`);
    }
  };

  return (
    <div className="app-container">
      <header>
        <h1>PDF OCR Search</h1>
        <p>Upload a PDF, find any text within it, with support for Bengali.</p>
      </header>
      
      <div className="card">
        {!file ? (
          <div className="uploader-container">
            <label htmlFor="file-upload" className="file-input-label">
              Select PDF File
            </label>
            <input id="file-upload" type="file" accept="application/pdf" onChange={handleFileChange} />
          </div>
        ) : (
          <div style={{textAlign: 'center'}}>
             <p className="file-name">Selected: {file.name}</p>
             <button className="btn btn-primary" onClick={processPdf} disabled={isLoading}>
                {isLoading ? 'Processing...' : 'Start OCR & Read PDF'}
             </button>
          </div>
        )}
         {error && <p className="error-message">{error}</p>}
      </div>

      {isLoading && (
        <div className="status-container card">
          <div className="spinner"></div>
          <p className="status-message">{statusMessage}</p>
        </div>
      )}

      {totalPages > 0 && !isLoading && (
        <div className="viewer-container card">
            <div className="controls">
                <input 
                    type="text" 
                    className="search-input"
                    placeholder="Enter name or text to find..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <button className="btn btn-primary" onClick={handleSearch}>Search</button>
            </div>
            {foundMessage && <div className="search-results">{foundMessage}</div>}

            <div className="pdf-pages-container">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(pageNumber => (
                    <div 
                        key={pageNumber} 
                        className={`page-container ${searchResults.includes(pageNumber) ? 'highlighted' : ''}`}
                        id={`page-${pageNumber}`}
                    >
                        <canvas 
                            className="page-canvas" 
                            ref={el => pageCanvasRefs.current[pageNumber - 1] = el}
                        ></canvas>
                        <div className="page-number">Page {pageNumber}</div>
                    </div>
                ))}
            </div>
        </div>
      )}
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);