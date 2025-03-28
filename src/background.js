// Enhanced background script for Google Meet Transcription Plugin

// Config constants
const CONFIG = {
    DEFAULT_LANGUAGE: "ru",
    WHISPER_MODEL: "whisper-1",
    DEFAULT_API_URL: "https://api.openai.com/v1/audio/transcriptions",
    AUTO_SAVE_INTERVAL: 60000, // Save state every minute
    DEFAULT_TIMEOUT: 60000,     // 1 minute timeout for requests
    MAX_RETRY_ATTEMPTS: 3,      // Maximum retry attempts for API calls
    MAX_CHUNK_SIZE: 25 * 1024 * 1024, // 25MB max size for audio chunks
    DEBUG_MODE: false,          // Set to true to enable verbose logging
  };
  
  // Global state
  const state = {
    chunkedTranscriptions: {},
    settings: {
      apiKey: "",
      apiUrl: CONFIG.DEFAULT_API_URL,
      defaultLanguage: CONFIG.DEFAULT_LANGUAGE,
      enableNotifications: true,
      authMethod: "bearer",
      apiService: "openai"
    },
    diagnostics: {
      lastError: null,
      apiCalls: [],
      activeRequests: 0
    }
  };
  
  // Initialize extension when installed or updated
  chrome.runtime.onInstalled.addListener(async () => {
    console.log("🔌 Extension installed/updated");
    
    // Load settings
    await loadSettings();
    
    // Load saved chunks
    await loadChunks();
    
    // Set up periodic saving of chunks state
    setInterval(saveChunksToStorage, CONFIG.AUTO_SAVE_INTERVAL);
    
    // Open options page when first installed
    if (!state.settings.apiKey) {
      chrome.runtime.openOptionsPage();
    }
  });
  
  // Load saved settings from storage
  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get([
        'apiKey', 
        'apiUrl', 
        'enableNotifications', 
        'defaultLanguage',
        'authMethod',
        'apiService'
      ]);
      
      // Update state with saved settings
      if (result.apiKey) state.settings.apiKey = result.apiKey;
      if (result.apiUrl) state.settings.apiUrl = result.apiUrl;
      if (result.hasOwnProperty('enableNotifications')) state.settings.enableNotifications = result.enableNotifications;
      if (result.defaultLanguage) state.settings.defaultLanguage = result.defaultLanguage;
      if (result.authMethod) state.settings.authMethod = result.authMethod;
      if (result.apiService) state.settings.apiService = result.apiService;
      
      debug("📋 Settings loaded", state.settings);
      return true;
    } catch (error) {
      console.error("❌ Error loading settings:", error);
      return false;
    }
  }
  
  // Load saved chunks from storage
  async function loadChunks() {
    try {
      const result = await chrome.storage.local.get(['transcriptionChunks']);
      
      if (result.transcriptionChunks) {
        Object.assign(state.chunkedTranscriptions, result.transcriptionChunks);
        debug(`📂 Loaded ${Object.keys(state.chunkedTranscriptions).length} meetings from storage`);
      }
      return true;
    } catch (error) {
      console.error("❌ Error loading chunks:", error);
      return false;
    }
  }
  
  // Save chunks to storage periodically
  function saveChunksToStorage() {
    if (Object.keys(state.chunkedTranscriptions).length > 0) {
      debug("💾 Saving chunks state to storage...");
      
      chrome.storage.local.set({
        transcriptionChunks: state.chunkedTranscriptions
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("❌ Error saving chunks state:", chrome.runtime.lastError);
        } else {
          debug("✅ Chunks state saved to storage");
        }
      });
    }
  }
  
  // API Client for handling Whisper API requests
  class ApiClient {
    constructor() {
      this.queue = [];
      this.isProcessing = false;
      this.retryDelays = [1000, 3000, 6000, 15000]; // Exponential backoff
      this.concurrentLimit = 1; // Process one at a time to avoid rate limits
      this.activeRequests = 0;
    }
    
    async sendToWhisperAPI(audioBlob, options = {}) {
      return new Promise((resolve, reject) => {
        const request = {
          audioBlob,
          apiUrl: options.apiUrl || state.settings.apiUrl || CONFIG.DEFAULT_API_URL,
          apiKey: options.apiKey || state.settings.apiKey,
          language: options.language || state.settings.defaultLanguage || CONFIG.DEFAULT_LANGUAGE,
          filename: options.filename || "recording.mp3",
          prompt: options.prompt || "This is a transcription of a Google Meet call.",
          resolve,
          reject
        };
        
        // Add to queue
        this.queue.push(request);
        
        // Start processing if not already running
        if (!this.isProcessing) {
          this.processQueue();
        }
      });
    }
    
    async processQueue() {
      if (this.queue.length === 0 || this.activeRequests >= this.concurrentLimit) {
        this.isProcessing = false;
        return;
      }
      
      this.isProcessing = true;
      this.activeRequests++;
      state.diagnostics.activeRequests = this.activeRequests;
      
      const request = this.queue.shift();
      debug(`🔄 Processing API request for ${request.filename} (${this.queue.length} in queue)`);
      
      try {
        const result = await this._makeRequest(request, 0);
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      } finally {
        this.activeRequests--;
        state.diagnostics.activeRequests = this.activeRequests;
        
        // Continue processing queue
        this.processQueue();
      }
    }
    
    async _makeRequest(request, retryCount) {
      try {
        debug(`🌍 Sending ${request.filename} to API (attempt ${retryCount + 1})`);
        
        // Create form data
        const formData = new FormData();
        formData.append("file", request.audioBlob, request.filename);
        formData.append("model", CONFIG.WHISPER_MODEL);
        formData.append("language", request.language);
        formData.append("response_format", "json");
        formData.append("temperature", "0.0");
        
        if (request.prompt) {
          formData.append("prompt", request.prompt);
        }
        
        // Set up headers based on auth method
        const headers = new Headers();
        const isProjectKey = request.apiKey.startsWith("sk-proj-");
        
        if (isProjectKey) {
          // More flexible auth for project keys
          headers.append("Authorization", `Bearer ${request.apiKey}`);
          headers.append("X-API-Key", request.apiKey);
        } else {
          // Standard OpenAI authentication
          headers.append("Authorization", `Bearer ${request.apiKey}`);
        }
        
        // Set up request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.DEFAULT_TIMEOUT);
        
        // Track API call start time
        const startTime = Date.now();
        
        // Send request
        const response = await fetch(request.apiUrl, {
          method: "POST",
          headers: headers,
          body: formData,
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        // Track API call in diagnostics
        state.diagnostics.apiCalls.push({
          timestamp: new Date().toISOString(),
          endpoint: request.apiUrl,
          status: response.status,
          duration: Date.now() - startTime,
          attempt: retryCount + 1
        });
        
        // Limit history size
        if (state.diagnostics.apiCalls.length > 10) {
          state.diagnostics.apiCalls = state.diagnostics.apiCalls.slice(-10);
        }
        
        // Check for rate limiting or server errors
        if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
          if (retryCount < this.retryDelays.length) {
            const delay = this.retryDelays[retryCount];
            debug(`⏳ Rate limited or server error (${response.status}). Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return this._makeRequest(request, retryCount + 1);
          }
        }
        
        // Check for HTTP errors
        if (!response.ok) {
          let errorMessage;
          try {
            const errorData = await response.json();
            errorMessage = errorData.error?.message || 
                           errorData.error || 
                           `HTTP error: ${response.status}`;
          } catch (e) {
            errorMessage = `HTTP error: ${response.status}`;
          }
          
          return { 
            success: false, 
            error: errorMessage,
            status: response.status
          };
        }
        
        // Parse successful response
        let result;
        try {
          result = await response.json();
        } catch (jsonError) {
          // Try to handle non-JSON responses
          const textResponse = await response.text();
          debug("⚠️ Non-JSON response received");
          
          if (textResponse.includes('"text"')) {
            try {
              const match = textResponse.match(/"text"\s*:\s*"([^"]*)"/);
              if (match && match[1]) {
                return {
                  success: true,
                  text: match[1]
                };
              }
            } catch (e) {
              console.error("❌ Failed to extract text from response");
            }
          }
          
          return {
            success: false,
            error: "Failed to parse API response",
            rawResponse: textResponse.substring(0, 500)
          };
        }
        
        if (result.text) {
          return {
            success: true,
            text: result.text
          };
        } else {
          return {
            success: false,
            error: "API returned response without text"
          };
        }
      } catch (error) {
        // Handle abort/timeout errors
        if (error.name === 'AbortError') {
          if (retryCount < this.retryDelays.length) {
            debug(`⏱️ Request timed out. Retrying...`);
            return this._makeRequest(request, retryCount + 1);
          }
          
          return {
            success: false,
            error: "Request timed out after multiple attempts"
          };
        }
        
        // For network errors, also retry
        if (error.message.includes('network') && retryCount < this.retryDelays.length) {
          const delay = this.retryDelays[retryCount];
          debug(`🌐 Network error. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this._makeRequest(request, retryCount + 1);
        }
        
        return {
          success: false,
          error: error.message,
          errorName: error.name
        };
      }
    }
  }
  
  // File Manager for handling downloads and storage
  class FileManager {
    constructor() {
      this.downloadDiagnostics = {
        attempts: [],
        lastError: null,
        addAttempt: function(method, result, error = null) {
          this.attempts.push({
            method,
            timestamp: new Date().toISOString(),
            success: !error,
            error: error ? error.message || String(error) : null,
            result
          });
          if (error) {
            this.lastError = error;
          }
        },
        reset: function() {
          this.attempts = [];
          this.lastError = null;
        },
        getSummary: function() {
          return {
            totalAttempts: this.attempts.length,
            methods: this.attempts.map(a => a.method),
            lastError: this.lastError ? (this.lastError.message || String(this.lastError)) : null,
            allErrors: this.attempts.filter(a => !a.success).map(a => a.error)
          };
        }
      };
    }
    
    // Main download method with multiple fallback strategies
    async saveTranscriptionToFile(transcription, filename) {
      debug("💾 Creating download file:", filename);
      
      // Reset diagnostics
      this.downloadDiagnostics.reset();
      
      // Validate and clean the text
      const validatedText = this._validateAndCleanTranscription(transcription);
      
      try {
        // Always save to storage first for recovery
        await this.storeTranscriptionData(validatedText, filename);
        this.downloadDiagnostics.addAttempt("storage", true);
        
        // Try methods in sequence until one succeeds
        try {
          // Method 1: Direct download with UTF-8 encoding
          const downloadId = await this._directDownload(validatedText, filename);
          this.downloadDiagnostics.addAttempt("direct_download", downloadId);
          return downloadId;
        } catch (directError) {
          this.downloadDiagnostics.addAttempt("direct_download", false, directError);
          debug("⚠️ Direct download failed, trying data URL method");
          
          try {
            // Method 2: Data URL method
            const downloadId = await this._dataUrlDownload(validatedText, filename);
            this.downloadDiagnostics.addAttempt("data_url", downloadId);
            return downloadId;
          } catch (dataUrlError) {
            this.downloadDiagnostics.addAttempt("data_url", false, dataUrlError);
            debug("⚠️ Data URL download failed, trying helper tab method");
            
            try {
              // Method 3: Helper tab method
              const tabId = await this._createDownloadTab(validatedText, filename);
              this.downloadDiagnostics.addAttempt("helper_tab", tabId);
              return tabId;
            } catch (tabError) {
              this.downloadDiagnostics.addAttempt("helper_tab", false, tabError);
              throw new Error("All download methods failed. Data is saved and can be accessed from popup.");
            }
          }
        }
      } catch (error) {
        const summary = this.downloadDiagnostics.getSummary();
        console.error("❌ Critical download error:", error, "Summary:", summary);
        
        // Still notify that data is accessible
        if (summary.methods.includes("storage")) {
          showNotification(
            "Text saved, but download failed", 
            "You can access the text from the extension popup"
          );
        }
        
        throw error;
      }
    }
    
    // Store transcription in local storage
    async storeTranscriptionData(text, filename, isComplete = true, chunkNumber = null) {
      return new Promise((resolve, reject) => {
        try {
          // Check available storage space
          chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
            const textBytes = new TextEncoder().encode(text).length;
            
            const transcriptionData = {
              text: text,
              filename: filename,
              timestamp: new Date().toISOString(),
              size: textBytes
            };
            
            // Add chunk info if applicable
            if (!isComplete && chunkNumber !== null) {
              transcriptionData.isChunk = true;
              transcriptionData.chunkNumber = chunkNumber;
            }
            
            chrome.storage.local.set({
              transcription: transcriptionData,
              diagnostics: {
                storageInfo: {
                  bytesInUse,
                  newContentSize: textBytes,
                  timestamp: new Date().toISOString()
                }
              }
            }, () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
              } else {
                debug(`✅ Transcription saved to storage: ${textBytes} bytes`);
                resolve(true);
              }
            });
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    
    // Process and clean transcription text
    _validateAndCleanTranscription(text) {
      if (!text || typeof text !== 'string') {
        throw new Error("Transcription text is invalid or empty");
      }
      
      // Remove any non-printable characters
      const cleanedText = text.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "");
      
      // Normalize line endings for cross-platform compatibility
      const normalizedText = cleanedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      
      // Add signature
      const finalText = normalizedText + "\n\n[Transcription by Google Meet Transcription Plugin]";
      
      return finalText;
    }
    
    // Direct download implementation
    async _directDownload(text, filename) {
      return new Promise((resolve, reject) => {
        try {
          // Add BOM for UTF-8
          const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
          const textEncoder = new TextEncoder();
          const encodedText = textEncoder.encode(text);
          
          // Combine BOM and encoded text
          const combinedArray = new Uint8Array(BOM.length + encodedText.length);
          combinedArray.set(BOM);
          combinedArray.set(encodedText, BOM.length);
          
          // Create blob with proper type
          const blob = new Blob([combinedArray], { 
            type: 'text/plain;charset=utf-8' 
          });
          
          // Get URL from blob
          const url = URL.createObjectURL(blob);
          
          // Use chrome.downloads API
          chrome.downloads.download({
            url: url,
            filename: filename,
            saveAs: false
          }, (downloadId) => {
            if (chrome.runtime.lastError) {
              URL.revokeObjectURL(url);
              reject(new Error(`Download API error: ${chrome.runtime.lastError.message}`));
            } else if (!downloadId) {
              URL.revokeObjectURL(url);
              reject(new Error("Download returned null ID"));
            } else {
              // Clean up URL after a delay
              setTimeout(() => URL.revokeObjectURL(url), 30000);
              
              // Monitor download progress
              chrome.downloads.onChanged.addListener(function onDownloadChanged(delta) {
                if (delta.id !== downloadId) return;
                
                if (delta.state?.current === 'complete') {
                  debug(`✅ Download complete [${downloadId}]`);
                  chrome.downloads.onChanged.removeListener(onDownloadChanged);
                  showNotification("Transcription complete", `File saved: ${filename}`);
                } else if (delta.error) {
                  console.error(`❌ Download error [${downloadId}]:`, delta.error.current);
                  chrome.downloads.onChanged.removeListener(onDownloadChanged);
                }
              });
              
              resolve(downloadId);
            }
          });
        } catch (error) {
          reject(error);
        }
      });
    }
    
    // Data URL download implementation
    async _dataUrlDownload(text, filename) {
      return new Promise((resolve, reject) => {
        try {
          debug("🔗 Creating data URL download...");
          
          // Create data URL with proper encoding
          const encoder = new TextEncoder();
          const encodedData = encoder.encode(text);
          const blob = new Blob([encodedData], { type: 'text/plain;charset=utf-8' });
          
          // Convert to data URL
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            
            // Use chrome.downloads API
            chrome.downloads.download({
              url: dataUrl,
              filename: filename,
              saveAs: false
            }, (downloadId) => {
              if (chrome.runtime.lastError) {
                reject(new Error(`Data URL download error: ${chrome.runtime.lastError.message}`));
              } else if (!downloadId) {
                reject(new Error("Data URL download returned null ID"));
              } else {
                debug("✅ Data URL download success, ID:", downloadId);
                resolve(downloadId);
              }
            });
          };
          
          reader.onerror = (e) => {
            reject(new Error("Failed to create data URL: " + e));
          };
          
          reader.readAsDataURL(blob);
        } catch (error) {
          reject(error);
        }
      });
    }
    
    // Helper tab download method for when other methods fail
    async _createDownloadTab(text, filename) {
      return new Promise((resolve, reject) => {
        try {
          chrome.tabs.create({ url: 'about:blank' }, (tab) => {
            if (!tab || !tab.id) {
              reject(new Error("Failed to create tab"));
              return;
            }
            
            debug("📄 Created helper tab, ID:", tab.id);
            
            // Execute script with maximum reliability
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              function: (text, name) => {
                // Create a download page
                document.documentElement.innerHTML = `
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>Transcription - ${name}</title>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            max-width: 800px;
                            margin: 0 auto;
                            padding: 20px;
                            background-color: #f5f5f5;
                        }
                        .container {
                            background-color: white;
                            border-radius: 8px;
                            padding: 20px;
                            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                        }
                        h1 {
                            color: #1a73e8;
                            font-size: 24px;
                        }
                        .btn {
                            background-color: #1a73e8;
                            color: white;
                            border: none;
                            padding: 10px 20px;
                            border-radius: 4px;
                            font-size: 16px;
                            cursor: pointer;
                            margin-right: 10px;
                            margin-bottom: 10px;
                        }
                        .btn.secondary {
                            background-color: #f8f9fa;
                            color: #1a73e8;
                            border: 1px solid #dadce0;
                        }
                        .btn:hover {
                            opacity: 0.9;
                        }
                        .content {
                            background-color: #f8f9fa;
                            border-radius: 4px;
                            padding: 15px;
                            margin-top: 20px;
                            max-height: 400px;
                            overflow-y: auto;
                            white-space: pre-wrap;
                            font-family: monospace;
                            font-size: 14px;
                            line-height: 1.5;
                        }
                        .status {
                            margin-top: 10px;
                            padding: 8px;
                            border-radius: 4px;
                            background-color: #e6f4ea;
                            color: #137333;
                            display: none;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>Google Meet Transcription</h1>
                        <p>Your transcription is ready. Use the buttons below to save the text.</p>
                        
                        <div>
                            <button id="downloadBtn" class="btn">Download as file</button>
                            <button id="copyBtn" class="btn secondary">Copy text</button>
                        </div>
                        
                        <div id="status" class="status"></div>
                        
                        <div class="content">${text}</div>
                        
                        <div class="footer">
                            <p>If you have trouble downloading, you can manually copy the text above.</p>
                        </div>
                    </div>
                    
                    <script>
                        // Download button handler
                        document.getElementById('downloadBtn').addEventListener('click', function() {
                            try {
                                const BOM = new Uint8Array([0xEF, 0xBB, 0xBF]);
                                const textContent = document.querySelector('.content').textContent;
                                const textEncoder = new TextEncoder();
                                const encodedText = textEncoder.encode(textContent);
                                
                                const combinedArray = new Uint8Array(BOM.length + encodedText.length);
                                combinedArray.set(BOM);
                                combinedArray.set(encodedText, BOM.length);
                                
                                const blob = new Blob([combinedArray], { 
                                    type: 'text/plain;charset=utf-8' 
                                });
                                
                                const url = URL.createObjectURL(blob);
                                
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = '${name}';
                                a.style.display = 'none';
                                
                                document.body.appendChild(a);
                                a.click();
                                
                                setTimeout(function() {
                                    document.body.removeChild(a);
                                    URL.revokeObjectURL(url);
                                    
                                    const status = document.getElementById('status');
                                    status.style.display = 'block';
                                    status.textContent = '✓ File downloaded';
                                    
                                    const btn = document.getElementById('downloadBtn');
                                    btn.textContent = '✓ Download complete';
                                }, 100);
                            } catch (e) {
                                alert('Download error: ' + e.message);
                            }
                        });
                        
                        // Copy button handler
                        document.getElementById('copyBtn').addEventListener('click', function() {
                            try {
                                const text = document.querySelector('.content').textContent;
                                
                                // Try modern clipboard API
                                if (navigator.clipboard) {
                                    navigator.clipboard.writeText(text)
                                        .then(function() {
                                            const status = document.getElementById('status');
                                            status.style.display = 'block';
                                            status.textContent = '✓ Text copied to clipboard';
                                            
                                            const btn = document.getElementById('copyBtn');
                                            btn.textContent = '✓ Copied';
                                            
                                            setTimeout(function() {
                                                btn.textContent = 'Copy text';
                                            }, 2000);
                                        })
                                        .catch(function(err) {
                                            // Try fallback method
                                            fallbackCopy();
                                        });
                                } else {
                                    fallbackCopy();
                                }
                                
                                function fallbackCopy() {
                                    const textarea = document.createElement('textarea');
                                    textarea.value = text;
                                    textarea.style.position = 'fixed';
                                    
                                    document.body.appendChild(textarea);
                                    textarea.focus();
                                    textarea.select();
                                    
                                    try {
                                        document.execCommand('copy');
                                        const status = document.getElementById('status');
                                        status.style.display = 'block';
                                        status.textContent = '✓ Text copied to clipboard';
                                        
                                        const btn = document.getElementById('copyBtn');
                                        btn.textContent = '✓ Copied';
                                        
                                        setTimeout(function() {
                                            btn.textContent = 'Copy text';
                                        }, 2000);
                                    } catch (e) {
                                        alert('Could not copy text: ' + e.message);
                                    }
                                    
                                    document.body.removeChild(textarea);
                                }
                            } catch (e) {
                                alert('Copy error: ' + e.message);
                            }
                        });
                        
                        // Auto-download
                        window.onload = function() {
                            setTimeout(function() {
                                document.getElementById('downloadBtn').click();
                            }, 500);
                        };
                    </script>
                </body>
                </html>
                `;
              },
              args: [text, filename]
            }, (results) => {
              if (chrome.runtime.lastError) {
                reject(new Error(`Script injection error: ${chrome.runtime.lastError.message}`));
              } else if (!results || results.length === 0) {
                reject(new Error("Script execution failed with empty results"));
              } else {
                debug("✅ Download page created successfully");
                showNotification(
                  "Transcription ready", 
                  "A page has been opened to download your file"
                );
                resolve(tab.id);
              }
            });
          });
        } catch (error) {
          reject(error);
        }
      });
    }
  }
  
  // Create singleton instances
  const apiClient = new ApiClient();
  const fileManager = new FileManager();
  
  // Handle messages from content scripts and popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Process audio with Whisper API
    if (message.type === "sendAudioToWhisper") {
      (async () => {
        try {
          debug("📩 Received audio file, processing...");
          
          // Check if this is a chunk
          const isChunk = message.chunkInfo && typeof message.chunkInfo === 'object';
          const chunkInfo = isChunk ? message.chunkInfo : { number: 1, isLast: true };
          
          // Generate a unique key for this meeting session
          const meetingName = message.meetingName || "Google Meet Call";
          const meetingKey = meetingName + "_" + (new Date().toISOString().split('T')[0]);
          
          if (isChunk) {
            showNotification(
              "Transcription", 
              `Processing part ${chunkInfo.number} of the recording...`
            );
          } else {
            showNotification(
              "Transcription", 
              "Processing the recording..."
            );
          }
  
          // Get API key and settings from storage
          await loadSettings();
          
          let apiKey = state.settings.apiKey;
          const language = state.settings.defaultLanguage || CONFIG.DEFAULT_LANGUAGE;
          const apiUrl = state.settings.apiUrl || CONFIG.DEFAULT_API_URL;
  
          if (!apiKey) {
            const error = "API key not configured. Open extension settings.";
            console.error("⚠ " + error);
            showNotification("API Error", error);
            sendResponse({ status: "❌ API Error", error });
            return;
          }
  
          // Decode Base64 audio data
          let audioData;
          try {
            const parts = message.file.split(',');
            const base64Data = parts[1];
            
            if (!base64Data) {
              throw new Error("Invalid audio file data");
            }
            
            // Decode Base64 to binary
            const byteCharacters = atob(base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            
            audioData = new Uint8Array(byteNumbers);
            debug("🔄 Audio data decoded, size:", (audioData.length / 1024).toFixed(2), "KB");
          } catch (error) {
            console.error("❌ Error decoding audio data:", error);
            showNotification("Error", "Failed to decode audio file");
            sendResponse({ status: "❌ Decoding error", error: error.message });
            return;
          }
  
          // Create audio blob with proper MIME type
          const audioBlob = new Blob([audioData], { type: 'audio/mp3' });
          
          debug("🔊 Audio file created:", 
                (audioBlob.size / 1024).toFixed(2), "KB,", 
                "type:", audioBlob.type);
  
          // Set appropriate prompt based on chunk
          let prompt;
          if (isChunk) {
            prompt = `This is part ${chunkInfo.number} of a Google Meet call transcription.`;
          } else {
            prompt = "This is a Google Meet call transcription.";
          }
          
          // Send to Whisper API
          showNotification("Transcription", "Sending audio to server...");
          
          try {
            const result = await apiClient.sendToWhisperAPI(audioBlob, {
              apiUrl,
              apiKey,
              language,
              filename: `recording_${isChunk ? `chunk${chunkInfo.number}` : 'full'}.mp3`,
              prompt
            });
            
            if (!result.success) {
              console.error("❌ API error:", result.error);
              showNotification("Processing error", result.error);
              sendResponse({ 
                status: "❌ API Error", 
                error: result.error,
                details: result
              });
              return;
            }
            
            // Check if we have transcription text
            if (result.text) {
              debug("📥 Successful response from Whisper");
              
              // If this is a chunk, handle it differently
              if (isChunk) {
                // Store or append the chunk transcription
                if (!state.chunkedTranscriptions[meetingKey]) {
                  state.chunkedTranscriptions[meetingKey] = [];
                }
                
                // Add this chunk
                state.chunkedTranscriptions[meetingKey].push({
                  chunkNumber: chunkInfo.number,
                  text: result.text,
                  timestamp: new Date().toISOString()
                });
                
                debug(`✅ Saved chunk #${chunkInfo.number} for ${meetingKey}, total: ${state.chunkedTranscriptions[meetingKey].length} chunks`);
                
                // If this is the last chunk, combine all chunks and save
                if (chunkInfo.isLast) {
                  const combinedTranscription = combineTranscriptions(state.chunkedTranscriptions[meetingKey]);
                  const filename = generateFilename(meetingName, true);
                  
                  // Save the combined transcription
                  try {
                    const downloadId = await fileManager.saveTranscriptionToFile(combinedTranscription, filename);
                    
                    showNotification("Transcription complete", "Full file saved as " + filename);
                    sendResponse({ 
                      status: "✅ Audio file processed", 
                      transcription: result.text,
                      filename: filename,
                      downloadId: downloadId,
                      isCompleted: true
                    });
                    
                    // Clean up after successful save
                    delete state.chunkedTranscriptions[meetingKey];
                    return;
                  } catch (downloadError) {
                    console.error("❌ Error saving file:", downloadError);
                    
                    showNotification("Text received, but saving failed", 
                                 "You can download the file through the extension popup");
                    sendResponse({ 
                      status: "⚠️ Transcription received, but saving failed", 
                      transcription: result.text,
                      filename: filename,
                      error: downloadError.message
                    });
                    return;
                  }
                } else {
                  // This is not the last chunk, just send success for this chunk
                  const chunkFilename = generateFilename(meetingName, false, chunkInfo.number);
                  
                  // Save only the current chunk for reference
                  try {
                    await fileManager.storeTranscriptionData(result.text, chunkFilename, false, chunkInfo.number);
                    
                    showNotification("Partial transcription ready", `Part ${chunkInfo.number} processed`);
                    sendResponse({ 
                      status: `✅ Audio file (part ${chunkInfo.number}) processed`, 
                      transcription: result.text,
                      filename: chunkFilename,
                      chunkNumber: chunkInfo.number,
                      isCompleted: false
                    });
                    return;
                  } catch (storeError) {
                    console.error("❌ Error saving part:", storeError);
                    
                    sendResponse({ 
                      status: `⚠️ Part ${chunkInfo.number} processed, but not saved`, 
                      transcription: result.text,
                      error: storeError.message
                    });
                    return;
                  }
                }
              } else {
                // Process a regular non-chunked transcription
                const filename = generateFilename(meetingName);
                
                try {
                  const downloadId = await fileManager.saveTranscriptionToFile(result.text, filename);
                  
                  showNotification("Transcription complete", "File saved as " + filename);
                  sendResponse({ 
                    status: "✅ Audio file processed", 
                    transcription: result.text,
                    filename: filename,
                    downloadId: downloadId
                  });
                  return;
                } catch (downloadError) {
                  console.error("❌ Error saving file:", downloadError);
                  
                  showNotification("Text received, but saving failed", 
                               "You can download the file through the extension popup");
                  sendResponse({ 
                    status: "⚠️ Transcription received, but saving failed", 
                    transcription: result.text,
                    filename: filename,
                    error: downloadError.message
                  });
                  return;
                }
              }
            } else {
              console.error("⚠ Response received, but no text found:", result);
              throw new Error("No text in API response");
            }
          } catch (error) {
            console.error("⚠ Critical error processing audio:", error);
            showNotification("Error", "An unexpected error occurred while processing audio");
            sendResponse({ status: "❌ Critical error", error: error.message });
          }
        } catch (error) {
          console.error("⚠ General error processing request:", error);
          showNotification("Error", "An unexpected error occurred");
          sendResponse({ status: "❌ General error", error: error.message });
        }
      })();
  
      return true; // Important for async sendResponse
    }
  
    // Combine chunks into a single transcription
    if (message.type === "combineChunks") {
      (async () => {
        try {
          const meetingKey = message.meetingKey;
          
          if (!meetingKey || !state.chunkedTranscriptions[meetingKey]) {
            sendResponse({ 
              success: false, 
              error: "No chunks found to combine" 
            });
            return;
          }
          
          const chunks = state.chunkedTranscriptions[meetingKey];
          debug(`🔄 Combining ${chunks.length} chunks for ${meetingKey}`);
          
          // Combine the chunks
          const combinedText = combineTranscriptions(chunks);
          
          // Extract meeting name from the key
          const meetingName = meetingKey.split('_')[0];
          const filename = generateFilename(meetingName, true);
          
          // Save the combined transcription
          try {
            const downloadId = await fileManager.saveTranscriptionToFile(combinedText, filename);
            
            showNotification("Transcription complete", "File saved as " + filename);
            
            // Clean up the chunks after successful save
            delete state.chunkedTranscriptions[meetingKey];
            saveChunksToStorage(); // Update storage immediately
            
            sendResponse({ 
              success: true, 
              filename: filename,
              downloadId: downloadId
            });
          } catch (downloadError) {
            console.error("❌ Error saving combined file:", downloadError);
            
            showNotification("Text combined, but saving failed", 
                         "You can download the file through the extension popup");
            
            // Store combined text for manual download
            try {
              await fileManager.storeTranscriptionData(combinedText, filename, true);
              
              sendResponse({ 
                success: true,
                savedToStorage: true,
                filename: filename,
                error: downloadError.message
              });
            } catch (storeError) {
              sendResponse({ 
                success: false, 
                error: "Storage error: " + storeError.message
              });
            }
          }
        } catch (error) {
          console.error("❌ Error combining chunks:", error);
          sendResponse({ 
            success: false, 
            error: "Combination error: " + error.message
          });
        }
      })();
      
      return true; // Important for async sendResponse
    }
  
    // Get chunks status
    if (message.type === "getChunksStatus") {
      sendResponse({
        success: true,
        hasChunks: Object.keys(state.chunkedTranscriptions).length > 0,
        meetings: Object.keys(state.chunkedTranscriptions),
        chunksCount: Object.values(state.chunkedTranscriptions).reduce((sum, chunks) => sum + chunks.length, 0)
      });
      
      return false; // Synchronous response
    }
  
    // Handle content script reinjection requests
    if (message.type === "reinjectContentScript") {
      (async () => {
        try {
          const tabId = message.tabId;
          
          if (!tabId) {
            sendResponse({ success: false, error: "No tab ID provided" });
            return;
          }
          
          // Check if the tab exists and is a Google Meet tab
          const tab = await chrome.tabs.get(tabId);
          if (!tab || !tab.url || !tab.url.includes("meet.google.com")) {
            sendResponse({ success: false, error: "Not a Google Meet tab" });
            return;
          }
          
          debug("🔄 Attempting to reinject content script in tab", tabId);
          
          // Inject the content script
          await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ["src/content.js"]
          });
          
          debug("✅ Content script reinjected successfully");
          sendResponse({ success: true });
        } catch (error) {
          console.error("❌ Failed to reinject content script:", error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      
      return true; // For async response
    }
  
    // Handle redownload requests
    if (message.type === "redownloadTranscription") {
      (async () => {
        debug("📥 Received transcription redownload request");
        
        try {
          // Get stored transcription
          const result = await chrome.storage.local.get(['transcription']);
          
          if (!result || !result.transcription || !result.transcription.text) {
            sendResponse({ success: false, error: "No saved transcription" });
            return;
          }
          
          debug("✅ Retrieved transcription from storage:", 
                `${result.transcription.text.length} chars,`,
                `Filename: ${result.transcription.filename}`);
          
          const { text, filename } = result.transcription;
          
          // Try all download methods
          try {
            // First show a confirmation message to let user know something is happening
            sendResponse({ 
              message: "Starting download...", 
              inProgress: true 
            });
            
            // Try download with all available methods
            const downloadResult = await fileManager.saveTranscriptionToFile(text, filename);
            
            sendResponse({ 
              success: true, 
              result: downloadResult,
              message: "Download started"
            });
          } catch (error) {
            console.error("❌ All download methods failed:", error);
            
            // Get detailed diagnostic info
            const diagInfo = fileManager.downloadDiagnostics.getSummary();
            
            sendResponse({ 
              success: false, 
              error: "Download failed: " + error.message,
              diagnostics: diagInfo,
              fallbackText: text,  // Send the text back for popup handling
              fallbackFilename: filename
            });
          }
        } catch (error) {
          console.error("❌ Critical error in redownload:", error);
          sendResponse({ 
            success: false, 
            error: "Critical error: " + error.message
          });
        }
      })();
      
      return true; // Important for async sendResponse
    }
  
    // Handle direct download requests
    if (message.type === "downloadTranscriptionAsFile") {
      (async () => {
        try {
          if (!message.text || !message.filename) {
            sendResponse({ 
              success: false, 
              error: "Missing text or filename" 
            });
            return;
          }
          
          // Temporary response to improve perceived performance
          sendResponse({ 
            inProgress: true, 
            message: "Starting download..." 
          });
          
          debug(`📥 Direct download request: ${message.filename}, ${message.text.length} chars`);
          
          // Try the download with all available methods
          try {
            const result = await fileManager.saveTranscriptionToFile(
              message.text, 
              message.filename
            );
            
            // Send success response
            chrome.runtime.sendMessage({
              type: "downloadResult",
              success: true,
              result: result,
              message: "Download started"
            });
          } catch (error) {
            console.error("❌ Download failed:", error);
            
            // Send failure response
            chrome.runtime.sendMessage({
              type: "downloadResult",
              success: false,
              error: error.message,
              diagnostics: fileManager.downloadDiagnostics.getSummary()
            });
          }
        } catch (error) {
          console.error("❌ Critical error in download handler:", error);
          
          // Send error response
          chrome.runtime.sendMessage({
            type: "downloadResult",
            success: false,
            error: "Critical error: " + error.message
          });
        }
      })();
      
      return true; // Important for async sendResponse
    }
  
    // Get diagnostics
    if (message.type === "getDiagnostics") {
      sendResponse({
        downloadDiagnostics: fileManager.downloadDiagnostics.getSummary(),
        lastError: fileManager.downloadDiagnostics.lastError ? 
                   (fileManager.downloadDiagnostics.lastError.message || String(fileManager.downloadDiagnostics.lastError)) : 
                   null,
        apiDiagnostics: {
          activeRequests: state.diagnostics.activeRequests,
          recentCalls: state.diagnostics.apiCalls
        },
        permissions: {
          downloads: typeof chrome.downloads !== 'undefined',
          tabs: typeof chrome.tabs !== 'undefined',
          scripting: typeof chrome.scripting !== 'undefined',
          storage: typeof chrome.storage !== 'undefined'
        }
      });
      return false; // Synchronous response
    }
    
    // Handle raw audio processing
    if (message.type === "processRawAudio") {
      (async () => {
        try {
          debug("📩 Received raw audio data, size:", 
                (message.audioData.length / 1024).toFixed(2), "KB");
          
          showNotification("Transcription", "Processing audio recording...");
  
          // Load settings
          await loadSettings();
          
          // Convert array back to binary data
          const audioData = new Uint8Array(message.audioData);
          
          // Try different audio formats
          let result = null;
          
          // First try: WAV format
          try {
            const wavFile = createWavFile(audioData);
            debug("💿 WAV file created, size:", (wavFile.size / 1024).toFixed(2), "KB");
            
            result = await sendToWhisperWithFormat(wavFile, "recording.wav", message.meetingName);
            if (result && result.success) {
              sendResponse(result);
              return;
            }
          } catch (wavError) {
            console.error("❌ Error with WAV format:", wavError);
          }
          
          // Second try: MP3-like format
          try {
            const mp3Blob = new Blob([audioData], { type: 'audio/mpeg' });
            debug("🎵 MP3 Blob created, size:", (mp3Blob.size / 1024).toFixed(2), "KB");
            
            result = await sendToWhisperWithFormat(mp3Blob, "recording.mp3", message.meetingName);
            if (result && result.success) {
              sendResponse(result);
              return;
            }
          } catch (mp3Error) {
            console.error("❌ Error with MP3 format:", mp3Error);
          }
          
          // Last attempt: M4A format
          try {
            const m4aBlob = new Blob([audioData], { type: 'audio/m4a' });
            debug("🔊 M4A Blob created, size:", (m4aBlob.size / 1024).toFixed(2), "KB");
            
            result = await sendToWhisperWithFormat(m4aBlob, "recording.m4a", message.meetingName);
            if (result && result.success) {
              sendResponse(result);
              return;
            }
          } catch (m4aError) {
            console.error("❌ Error with M4A format:", m4aError);
          }
          
          // If we get here, all attempts failed
          console.error("❌ All audio format attempts failed");
          showNotification("Error", "Failed to process audio file");
          sendResponse({ 
            status: "❌ Processing error", 
            error: "All audio format attempts failed"
          });
        } catch (error) {
          console.error("⚠ General processing error:", error);
          showNotification("Error", "An unexpected error occurred");
          sendResponse({ status: "❌ General error", error: error.message });
        }
      })();
      
      return true; // Important for async sendResponse
    }
  });
  
  // Helper function to send audio to Whisper with specific format
  async function sendToWhisperWithFormat(audioBlob, filename, meetingName) {
    try {
      const result = await apiClient.sendToWhisperAPI(audioBlob, {
        filename: filename
      });
      
      if (!result.success) {
        return { success: false, error: result.error };
      }
      
      // Process successful result
      const outputFilename = generateFilename(meetingName);
      
      try {
        const downloadId = await fileManager.saveTranscriptionToFile(result.text, outputFilename);
        
        showNotification("Transcription complete", "File saved as " + outputFilename);
        return { 
          success: true,
          status: "✅ Audio file processed", 
          transcription: result.text,
          filename: outputFilename,
          downloadId: downloadId
        };
      } catch (downloadError) {
        console.error("❌ Error saving file:", downloadError);
        
        // Store transcription for access through popup
        await fileManager.storeTranscriptionData(result.text, outputFilename);
        
        showNotification("Text received, but saving failed", 
                     "You can download the file through the extension popup");
        return { 
          success: true,
          status: "⚠️ Transcription received, but saving failed", 
          transcription: result.text,
          filename: outputFilename,
          error: downloadError.message
        };
      }
    } catch (error) {
      console.error("❌ Error sending to Whisper:", error);
      return null;
    }
  }
  
  // Create simple WAV file from raw audio data
  function createWavFile(audioData) {
    // This is a simplified approach - creating a "fake" WAV
    // by adding a basic WAV header to the audio data
    
    // Basic WAV header for 16kHz mono audio
    const wavHeader = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0, 0, 0, 0,             // File size (filled later)
      0x57, 0x41, 0x56, 0x45, // "WAVE"
      0x66, 0x6D, 0x74, 0x20, // "fmt "
      16, 0, 0, 0,            // fmt chunk size
      1, 0,                   // Audio format (1 = PCM)
      1, 0,                   // Number of channels
      0x80, 0x3E, 0, 0,       // Sample rate (16000 Hz)
      0, 0, 0, 0,             // Byte rate (filled later)
      2, 0,                   // Block align
      16, 0,                  // Bits per sample
      0x64, 0x61, 0x74, 0x61, // "data"
      0, 0, 0, 0              // Data size (filled later)
    ]);
    
    // Fill in the file size
    const fileSize = audioData.length + 36;
    wavHeader[4] = fileSize & 0xff;
    wavHeader[5] = (fileSize >> 8) & 0xff;
    wavHeader[6] = (fileSize >> 16) & 0xff;
    wavHeader[7] = (fileSize >> 24) & 0xff;
    
    // Fill in the byte rate
    const byteRate = 16000 * 1 * 16 / 8;
    wavHeader[28] = byteRate & 0xff;
    wavHeader[29] = (byteRate >> 8) & 0xff;
    wavHeader[30] = (byteRate >> 16) & 0xff;
    wavHeader[31] = (byteRate >> 24) & 0xff;
    
    // Fill in the data size
    wavHeader[40] = audioData.length & 0xff;
    wavHeader[41] = (audioData.length >> 8) & 0xff;
    wavHeader[42] = (audioData.length >> 16) & 0xff;
    wavHeader[43] = (audioData.length >> 24) & 0xff;
    
    // Combine header and audio data
    const wavFile = new Blob([wavHeader, audioData], { type: 'audio/wav' });
    return wavFile;
  }
  
  // Combine transcriptions from multiple chunks
  function combineTranscriptions(chunks) {
    if (!chunks || chunks.length === 0) {
      return "No transcript content available.";
    }
    
    // Sort chunks by number to ensure correct order
    chunks.sort((a, b) => a.chunkNumber - b.chunkNumber);
    
    let combinedText = "# Complete Google Meet Call Transcription\n\n";
    
    // Add timestamp for the complete transcription
    combinedText += `Date: ${new Date().toLocaleString()}\n\n`;
    
    // Add each chunk with proper formatting
    chunks.forEach((chunk, index) => {
      combinedText += `## Part ${chunk.chunkNumber}\n\n`;
      combinedText += chunk.text.trim() + "\n\n";
      
      // Add separator between chunks, except for the last one
      if (index < chunks.length - 1) {
        combinedText += "---\n\n";
      }
    });
    
    // Add footer
    combinedText += "\n[End of Transcription]\n";
    
    return combinedText;
  }
  
  // Generate filename based on meeting name and time
  function generateFilename(meetingName, isComplete = true, chunkNumber = null) {
    const date = new Date();
    const formattedDate = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const formattedTime = date.toTimeString().slice(0, 8).replace(/:/g, "-"); // HH-MM-SS
    
    // Clean meeting name or use default
    const cleanName = meetingName 
      ? meetingName.replace(/[^\w\s-]/g, "").substring(0, 30).trim() 
      : "meeting";
    
    if (isComplete) {
      return `transcription_${cleanName}_${formattedDate}_${formattedTime}.txt`;
    } else {
      return `transcription_${cleanName}_part${chunkNumber}_${formattedDate}_${formattedTime}.txt`;
    }
  }
  
  // Show notification to user
  function showNotification(title, message) {
    if (state.settings.enableNotifications === false) {
      return; // Notifications disabled
    }
    
    if (typeof chrome.notifications !== 'undefined' && chrome.notifications.create) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: '/images/icon128.png',
        title: title,
        message: message
      });
    } else {
      debug(`🔔 NOTIFICATION: ${title} - ${message}`);
    }
  }
  
  // Debug logging helper
  function debug(message, data) {
    if (CONFIG.DEBUG_MODE) {
      if (data) {
        console.log(`🔍 ${message}`, data);
      } else {
        console.log(`🔍 ${message}`);
      }
    }
  }
  
  // Load chunks from storage on startup
  chrome.runtime.onStartup.addListener(async () => {
    await loadSettings();
    await loadChunks();
  });