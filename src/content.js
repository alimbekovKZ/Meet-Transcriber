/**
 * Google Meet Transcription Plugin - content.js
 * This script runs on Google Meet pages to capture and process audio for transcription
 */

// =====================================================================
// CONSTANTS AND CONFIGURATION
// =====================================================================

// Chunking configuration for handling long recordings
const CHUNK_CONFIG = {
    duration: 15 * 60 * 1000,     // 15 minutes default chunk size
    maxSizeBytes: 15 * 1024 * 1024, // 15MB size threshold
    processingTimeout: 5 * 60 * 1000, // 5 minute timeout for processing
    recordingInterval: 1000,      // Check recording state every second
    memoryCheckInterval: 30 * 1000, // Check memory usage every 30 seconds
    minChunkSize: 100 * 1024      // Minimum 100KB before creating a chunk
  };
  
  // UI Constants for customization
  const UI_CONFIG = {
    notificationDuration: 5000,    // Default notification display time in ms
    recordingIndicatorPosition: 'top-left', // Position of recording indicator
    allowDraggableIndicator: true, // Whether recording indicator can be dragged
    showTimerInIndicator: true,    // Show elapsed time in recording indicator
    confirmOnStop: true           // Confirm before stopping long recordings
  };
  
  // =====================================================================
  // GLOBAL VARIABLES
  // =====================================================================
  
  // Recording state
  let audioContext;
  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;
  let recordingStartTime = 0;
  let elapsedTimeInterval = null;
  
  // Meeting detection
  let meetingObserver = null;
  let autoTranscriptionEnabled = true;
  let hasRequestedPermission = false;
  let meetDetected = false;
  let meetingName = "Google Meet Call";
  
  // Audio stream management
  let cachedAudioStream = null;
  let audioSource = null;
  
  // Chunking system variables
  let currentChunkStartTime = 0;
  let chunkCounter = 0;
  let chunkTimer = null;
  let memoryCheckTimer = null;
  let isProcessingChunk = false;
  let pendingChunks = [];
  
  // Recording statistics
  let recordingStats = {
    totalBytes: 0,
    totalDuration: 0,
    chunks: [],
    peakMemoryUsage: 0,
    lastNetworkActivity: null
  };
  
  // =====================================================================
  // INITIALIZATION
  // =====================================================================
  
  /**
   * Initialize the extension when page loads
   */
  window.addEventListener('load', () => {
    console.log("🔌 Google Meet Transcription Plugin initializing...");
    
    // Only activate on Google Meet pages
    if (window.location.href.includes('meet.google.com')) {
      console.log("🔍 Google Meet page detected");
      
      // Load settings from storage
      loadSettings()
        .then(() => {
          // Only initialize meeting detection if enabled
          if (autoTranscriptionEnabled) {
            initializeMeetDetection();
          } else {
            console.log("📌 Auto-transcription disabled in settings");
          }
          
          // Initialize message handlers regardless of auto setting
          setupMessageHandlers();
          
          // Signal that content script is alive
          sendStatusUpdateToBackground();
        })
        .catch(error => {
          console.error("❌ Error loading settings:", error);
        });
    }
  });
  
  /**
   * Load user settings from Chrome storage
   */
  async function loadSettings() {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get([
        'autoTranscription', 
        'enableNotifications',
        'defaultLanguage',
        'chunkDuration'
      ], (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        
        // Apply settings with defaults
        autoTranscriptionEnabled = result.hasOwnProperty('autoTranscription') 
          ? result.autoTranscription 
          : true;
        
        // Apply custom chunk duration if set (in minutes, convert to ms)
        if (result.chunkDuration && result.chunkDuration > 0) {
          CHUNK_CONFIG.duration = result.chunkDuration * 60 * 1000;
        }
        
        resolve(result);
      });
    });
  }
  
  /**
   * Send status update to background script
   */
  function sendStatusUpdateToBackground() {
    try {
      chrome.runtime.sendMessage({
        type: "contentScriptStatus",
        status: "active",
        url: window.location.href,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.warn("⚠️ Failed to send status to background:", error);
    }
  }
  
  // =====================================================================
  // MEETING DETECTION
  // =====================================================================
  
  /**
   * Initialize the meeting detection system
   */
  function initializeMeetDetection() {
    if (meetingObserver) {
      console.log("⚠️ Meeting observer already initialized");
      return;
    }
    
    console.log("🔍 Initializing meeting detection");
    
    // Create MutationObserver with debouncing
    let debounceTimeout = null;
    
    meetingObserver = new MutationObserver((mutations) => {
      // Prevent frequent calls with debounce
      if (debounceTimeout) clearTimeout(debounceTimeout);
      
      debounceTimeout = setTimeout(() => {
        // Only check if meeting not yet detected
        if (!meetDetected) {
          checkForActiveMeeting();
        }
      }, 1000);
    });
    
    // Observe DOM changes
    meetingObserver.observe(document.body, { 
      childList: true, 
      subtree: true,
      attributes: true,
      attributeFilter: ['data-call-started', 'data-meeting-active']
    });
    
    // Also check current state (may already be in a meeting)
    checkForActiveMeeting();
    
    // Handle page unload
    window.addEventListener('beforeunload', cleanupResources);
  }
  
  /**
   * Check if user is currently in an active meeting
   */
  function checkForActiveMeeting() {
    // Multiple indicators for meeting detection for reliability
    const callStarted = 
      document.querySelector('[data-call-started]') || 
      document.querySelector('[data-meeting-active]') ||
      document.querySelectorAll('video').length > 1 ||
      document.querySelector('.r6xAKc') !== null ||
      document.querySelector('[data-meeting-code]') !== null;
    
    // If meeting detected and auto-transcription enabled
    if (callStarted && !meetDetected && autoTranscriptionEnabled && !hasRequestedPermission) {
      meetDetected = true;
      console.log("🎉 Active Google Meet call detected");
      
      // Extract meeting name for later use
      updateMeetingInfo();
      
      // Show permission prompt for recording
      showPermissionPrompt();
    }
  }
  
  /**
   * Update meeting information from the page
   */
  function updateMeetingInfo() {
    // Try multiple selectors to get meeting name
    const meetingNameElement = 
      document.querySelector('[data-meeting-title]') || 
      document.querySelector('.r6xAKc') ||
      document.querySelector('.u6vdEc');
      
    if (meetingNameElement) {
      meetingName = meetingNameElement.textContent.trim();
      console.log(`📝 Meeting name: ${meetingName}`);
    }
    
    // Get meeting code if available
    const codeElement = document.querySelector('[data-meeting-code]');
    if (codeElement) {
      const meetingCode = codeElement.getAttribute('data-meeting-code');
      console.log(`🔢 Meeting code: ${meetingCode}`);
    }
    
    // Update global variable for use in transcription
    window.meetingName = meetingName;
  }
  
  /**
   * Show prompt to request permission to start recording
   */
  function showPermissionPrompt() {
    console.log("🔔 Showing recording permission prompt");
    
    // Check if prompt already exists
    if (document.getElementById('gtm-permission-prompt')) {
      return;
    }
    
    // Create prompt container
    const promptBox = document.createElement('div');
    promptBox.id = 'gtm-permission-prompt';
    promptBox.className = 'gtm-permission-prompt';
    promptBox.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background-color: white;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 16px;
      width: 300px;
      z-index: 10000;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
      animation: gtm-slide-in 0.3s ease-out;
    `;
    
    // Add animation styles
    const style = document.createElement('style');
    style.textContent = `
      @keyframes gtm-slide-in {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      @keyframes gtm-fade-out {
        from { opacity: 1; }
        to { opacity: 0; }
      }
      .gtm-permission-prompt.hiding {
        animation: gtm-fade-out 0.3s ease-out forwards;
      }
    `;
    document.head.appendChild(style);
    
    // Populate prompt content
    promptBox.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 12px;">
        <div style="width: 24px; height: 24px;">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
        </div>
        <div style="font-weight: 500; color: #202124; font-size: 16px;">Google Meet Transcription</div>
      </div>
      <p style="margin: 0 0 12px 0; color: #5f6368; font-size: 14px;">
        Active call detected. Would you like to transcribe this meeting?
      </p>
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="gtm-prompt-later" style="background: none; border: none; color: #5f6368; font-family: inherit; font-size: 14px; padding: 8px; cursor: pointer; border-radius: 4px;">
          Later
        </button>
        <button id="gtm-prompt-never" style="background: none; border: none; color: #5f6368; font-family: inherit; font-size: 14px; padding: 8px; cursor: pointer; border-radius: 4px;">
          Don't record
        </button>
        <button id="gtm-prompt-start" style="background: #1a73e8; border: none; color: white; font-family: inherit; font-size: 14px; padding: 8px 16px; cursor: pointer; border-radius: 4px;">
          Start recording
        </button>
      </div>
    `;
    
    // Add to page
    document.body.appendChild(promptBox);
    
    // Button handlers
    document.getElementById('gtm-prompt-start').addEventListener('click', () => {
      hidePrompt(promptBox);
      hasRequestedPermission = true;
      startRecording();
    });
    
    document.getElementById('gtm-prompt-later').addEventListener('click', () => {
      hidePrompt(promptBox);
    });
    
    document.getElementById('gtm-prompt-never').addEventListener('click', () => {
      hidePrompt(promptBox);
      disableAutoTranscription();
    });
    
    // Auto-hide after 30 seconds
    setTimeout(() => {
      if (document.getElementById('gtm-permission-prompt')) {
        hidePrompt(promptBox);
      }
    }, 30000);
  }
  
  /**
   * Smoothly hide the permission prompt
   */
  function hidePrompt(promptBox) {
    promptBox.classList.add('hiding');
    setTimeout(() => {
      if (promptBox.parentNode) {
        promptBox.remove();
      }
    }, 300);
  }
  
  // =====================================================================
  // AUDIO CAPTURE AND RECORDING
  // =====================================================================
  
  /**
   * Start recording audio from the meeting
   */
  async function startRecording() {
    console.log("🎙 Starting recording...");
    
    if (isRecording) {
      console.log("⚠️ Recording already in progress");
      return;
    }
  
    try {
      // Get audio stream
      let stream = await getAudioStream();
      
      if (!stream) {
        console.error("❌ Failed to get audio stream");
        showNotification(
          "Recording error", 
          "Failed to access audio. Check browser permissions.",
          "error"
        );
        return;
      }
      
      // Cache successful stream
      cachedAudioStream = stream;
  
      // Reset recording state
      audioChunks = [];
      chunkCounter = 0;
      recordingStartTime = Date.now();
      currentChunkStartTime = Date.now();
      
      // Initialize recording statistics
      recordingStats = {
        totalBytes: 0,
        totalDuration: 0,
        chunks: [],
        peakMemoryUsage: 0,
        lastNetworkActivity: null
      };
  
      // Create MediaRecorder with optimal format
      let options = { mimeType: 'audio/webm;codecs=opus' };
      
      try {
        mediaRecorder = new MediaRecorder(stream, options);
      } catch (e) {
        // Fallback to standard format if opus not supported
        console.warn("⚠️ Opus codec not supported, trying standard WebM");
        try {
          options = { mimeType: 'audio/webm' };
          mediaRecorder = new MediaRecorder(stream, options);
        } catch (e2) {
          // Last resort: try without specifying format
          console.warn("⚠️ WebM not supported, using default format");
          mediaRecorder = new MediaRecorder(stream);
        }
      }
      
      if (!mediaRecorder) {
        throw new Error("Failed to create MediaRecorder with supported formats");
      }
      
      // Set up data handling
      mediaRecorder.ondataavailable = handleAudioData;
      
      // Handle recording state changes
      mediaRecorder.onstart = () => {
        console.log("▶ Recording started using format:", mediaRecorder.mimeType);
        isRecording = true;
        startElapsedTimeCounter();
      };
      
      mediaRecorder.onpause = () => {
        console.log("⏸ Recording paused");
      };
      
      mediaRecorder.onresume = () => {
        console.log("▶ Recording resumed");
      };
      
      mediaRecorder.onerror = (event) => {
        console.error("❌ MediaRecorder error:", event.error);
        showNotification(
          "Recording error", 
          `Error during recording: ${event.error.name}`,
          "error"
        );
      };
      
      mediaRecorder.onstop = () => {
        console.log("⏹ MediaRecorder stopped");
        stopElapsedTimeCounter();
        isRecording = false;
      };
  
      // Start recording with small chunks for better reliability
      mediaRecorder.start(500); // 500ms chunks
      
      // Show recording indicator
      showRecordingIndicator();
      
      // Set up chunking system
      setupChunkingSystem();
      
      // Notify user
      showNotification(
        "Recording started", 
        `Recording audio from ${audioSource || "meeting"}`,
        "success"
      );
      
      // Notify background script
      chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "started",
        audioSource: audioSource,
        timestamp: new Date().toISOString(),
        meetingName: meetingName
      });
      
      return true;
    } catch (error) {
      console.error("❌ Error starting recording:", error);
      showNotification(
        "Recording error", 
        `Failed to start recording: ${error.message}`,
        "error"
      );
      return false;
    }
  }
  
  /**
   * Handle incoming audio data chunks
   */
  function handleAudioData(event) {
    if (event.data && event.data.size > 0) {
      audioChunks.push(event.data);
      
      // Update stats
      recordingStats.totalBytes += event.data.size;
      if (recordingStats.totalBytes > recordingStats.peakMemoryUsage) {
        recordingStats.peakMemoryUsage = recordingStats.totalBytes;
      }
      
      // Log chunk info (less frequently for performance)
      if (audioChunks.length % 10 === 0) {
        console.log(`📊 Audio chunks: ${audioChunks.length}, Total size: ${(recordingStats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
      }
      
      // Check if we need to process due to size constraints
      if (getTotalChunkSize() > CHUNK_CONFIG.maxSizeBytes) {
        console.log("⚠️ Size threshold reached. Processing chunk early.");
        processCurrentChunk(true);
      }
    }
  }
  
  /**
   * Get total size of audio chunks
   */
  function getTotalChunkSize() {
    return audioChunks.reduce((total, chunk) => total + chunk.size, 0);
  }
  
  /**
   * Stop recording and process any remaining audio
   */
  async function stopRecording() {
    console.log("🛑 Stopping recording...");
  
    if (!isRecording || !mediaRecorder) {
      console.log("⚠️ No active recording to stop");
      return false;
    }
  
    // Clear all timers
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    
    if (memoryCheckTimer) {
      clearInterval(memoryCheckTimer);
      memoryCheckTimer = null;
    }
    
    // Stop elapsed time counter
    stopElapsedTimeCounter();
  
    // Update recording state
    isRecording = false;
    
    // Hide recording indicator
    hideRecordingIndicator();
    
    try {
      // Process final chunk if we have data
      if (audioChunks.length > 0) {
        // Return a promise for the final chunk processing
        return new Promise((resolve) => {
          // Stop the media recorder if it's active
          if (mediaRecorder.state === "recording" || mediaRecorder.state === "paused") {
            mediaRecorder.stop();
          }
          
          console.log(`📦 Processing final recording chunk (${audioChunks.length} chunks)`);
          
          // Process as final chunk (isLast=true)
          processCurrentChunk(false).then(() => {
            console.log("✅ Final chunk processed");
            resolve(true);
          }).catch(error => {
            console.error("❌ Error processing final chunk:", error);
            resolve(false);
          });
        });
      } else {
        // No audio data to process
        if (mediaRecorder.state === "recording" || mediaRecorder.state === "paused") {
          mediaRecorder.stop();
        }
        
        console.log("ℹ️ No audio data to process");
        return false;
      }
    } catch (error) {
      console.error("❌ Error stopping recording:", error);
      
      // Make sure mediaRecorder is stopped
      try {
        if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
          mediaRecorder.stop();
        }
      } catch (e) {
        console.error("❌ Error stopping MediaRecorder:", e);
      }
      
      // Notify background script about error
      chrome.runtime.sendMessage({
        type: "recordingStatus",
        status: "error",
        error: error.message,
        timestamp: new Date().toISOString()
      });
      
      return false;
    }
  }
  
  /**
   * Enhanced audio capture function with multiple fallback methods
   */
  async function getAudioStream() {
    console.log("🎧 Requesting audio capture access...");
  
    try {
      // Method 1: Try cached stream first (more efficient)
      if (cachedAudioStream && cachedAudioStream.active) {
        console.log("✅ Using cached audio stream");
        audioSource = window.audioSource || "cached";
        return cachedAudioStream;
      }
  
      // Method 2: Try getDisplayMedia with system audio (best quality)
      try {
        console.log("🖥️ Requesting display capture with system audio...");
        
        const displayMediaOptions = {
          video: { 
            cursor: "never",
            displaySurface: "monitor",
            logicalSurface: true,
            width: 1,
            height: 1
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          preferCurrentTab: false,
          selfBrowserSurface: "exclude",
          systemAudio: "include" // Chrome-specific
        };
        
        const displayStream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
        
        // Check if we got audio tracks
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log("✅ System audio stream obtained via getDisplayMedia");
          
          // Stop video tracks to save resources
          displayStream.getVideoTracks().forEach(track => {
            track.stop();
          });
          
          // Create a new stream with audio only
          const audioOnlyStream = new MediaStream(audioTracks);
          
          // Store source type for diagnostics
          audioSource = "system";
          window.audioSource = audioSource;
          
          // Cache the stream for future use
          cachedAudioStream = audioOnlyStream;
          return audioOnlyStream;
        } else {
          console.warn("⚠️ Display capture succeeded but no audio tracks found");
          displayStream.getTracks().forEach(track => track.stop());
        }
      } catch (displayErr) {
        console.warn("⚠️ Display capture failed:", displayErr.name, displayErr.message);
      }
      
      // Method 3: Tab-specific audio capture (Chrome 103+)
      try {
        console.log("🔄 Trying tab-specific audio capture...");
        
        // This only works in Chrome 103+ and needs tab permission
        const tabCaptureOptions = {
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          },
          video: false,
          preferCurrentTab: true
        };
        
        const tabStream = await navigator.mediaDevices.getDisplayMedia(tabCaptureOptions);
        
        const audioTracks = tabStream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log("✅ Tab audio stream obtained");
          
          // Create a new stream with audio only
          const audioOnlyStream = new MediaStream(audioTracks);
          
          audioSource = "tab";
          window.audioSource = audioSource;
          cachedAudioStream = audioOnlyStream;
          return audioOnlyStream;
        } else {
          console.warn("⚠️ Tab capture succeeded but no audio tracks found");
          tabStream.getTracks().forEach(track => track.stop());
        }
      } catch (tabErr) {
        console.warn("⚠️ Tab audio capture failed:", tabErr.name, tabErr.message);
      }
      
      // Method 4: Microphone fallback (most compatible)
      try {
        console.log("🎤 Trying microphone fallback...");
        
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 16000, // Optimal for speech recognition
            channelCount: 1    // Mono is better for speech
          }
        });
        
        const audioTracks = micStream.getAudioTracks();
        if (audioTracks.length > 0) {
          console.log("✅ Microphone audio stream obtained");
          audioSource = "microphone";
          window.audioSource = audioSource;
          cachedAudioStream = micStream;
          
          // Show notification about using microphone
          showNotification(
            "Using microphone for recording", 
            "System audio capture unavailable - using microphone instead",
            "info",
            8000 // Longer duration for this important message
          );
          
          return micStream;
        } else {
          console.warn("⚠️ Microphone access succeeded but no audio tracks found");
          micStream.getTracks().forEach(track => track.stop());
        }
      } catch (micErr) {
        console.error("❌ Microphone access failed:", micErr.name, micErr.message);
        
        // Handle specific errors
        if (micErr.name === 'NotAllowedError') {
          showNotification(
            "Permission denied", 
            "Microphone access was denied. Recording requires audio permission.",
            "error",
            10000
          );
        }
      }
      
      // Method 5: Final fallback - minimal constraints
      try {
        console.log("🔄 Trying minimal audio constraints as last resort...");
        const basicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        if (basicStream && basicStream.getAudioTracks().length > 0) {
          console.log("✅ Basic audio stream obtained as last resort");
          audioSource = "basic_microphone";
          window.audioSource = audioSource;
          cachedAudioStream = basicStream;
          return basicStream;
        }
      } catch (fallbackErr) {
        console.error("❌ All audio capture methods failed");
      }
      
      throw new Error("Failed to capture audio from any source");
    } catch (error) {
      console.error("❌ Audio capture critical error:", error);
      
      // Send diagnostics to background script
      chrome.runtime.sendMessage({
        type: "audioCaptureDiagnostics",
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        },
        browserInfo: {
          userAgent: navigator.userAgent,
          platform: navigator.platform
        }
      });
      
      return null;
    }
  }
  
  // =====================================================================
  // AUDIO CHUNKING SYSTEM
  // =====================================================================
  
  /**
   * Set up the chunking system for handling long recordings
   */
  function setupChunkingSystem() {
    // Reset chunking state
    chunkCounter = 0;
    currentChunkStartTime = Date.now();
    pendingChunks = [];
    
    // Clear any existing timers
    if (chunkTimer) clearTimeout(chunkTimer);
    if (memoryCheckTimer) clearInterval(memoryCheckTimer);
    
    // Set chunk processing timer
    chunkTimer = setTimeout(() => {
      if (isRecording && audioChunks.length > 0) {
        console.log("⏰ Chunk timer triggered - processing current audio segment");
        processCurrentChunk(true);
      }
    }, CHUNK_CONFIG.duration);
    
    // Set up memory usage monitoring
    memoryCheckTimer = setInterval(() => {
      if (isRecording) {
        checkMemoryUsage();
      }
    }, CHUNK_CONFIG.memoryCheckInterval);
    
    console.log("🔄 Chunking system initialized with duration:", 
      Math.floor(CHUNK_CONFIG.duration / 60 / 1000), "minutes per chunk");
  }
  
  /**
   * Check memory usage and trigger chunk processing if needed
   */
  function checkMemoryUsage() {
    const totalSize = getTotalChunkSize();
    
    // Log current memory usage (less frequently)
    if (chunkCounter === 0 || totalSize > CHUNK_CONFIG.maxSizeBytes / 2) {
      console.log(`📊 Current audio buffer size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
    }
    
    // If we're approaching memory limits, process the chunk early
    if (totalSize > CHUNK_CONFIG.maxSizeBytes) {
      console.log("⚠️ Memory threshold reached - processing chunk early");
      processCurrentChunk(true);
    }
  }
  
  /**
   * Process current audio chunk with improved reliability
   */
  async function processCurrentChunk(continueRecording) {
    // Check if we have enough data to process
    if (audioChunks.length === 0 || getTotalChunkSize() < CHUNK_CONFIG.minChunkSize) {
      console.log("⚠️ Not enough audio data to process. Skipping chunk processing.");
      
      // Reset timer if continuing
      if (continueRecording) {
        if (chunkTimer) clearTimeout(chunkTimer);
        chunkTimer = setTimeout(() => {
          if (isRecording && audioChunks.length > 0) {
            processCurrentChunk(true);
          }
        }, CHUNK_CONFIG.duration);
      }
      return;
    }
  
    // Prevent multiple simultaneous processing
    if (isProcessingChunk) {
      console.log("⚠️ Already processing a chunk, queuing this request");
      pendingChunks.push({ continueRecording });
      return;
    }
    
    isProcessingChunk = true;
    console.log(`🔄 Processing chunk #${chunkCounter + 1}`);
    
    try {
      // Pause recording if active
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.pause();
        console.log("⏸ Recording paused for chunk processing");
      }
      
      // Make a copy of current chunks and reset for next recording
      const chunksToProcess = [...audioChunks];
      audioChunks = [];
      
      // Calculate duration and increment counter
      const chunkDurationMs = Date.now() - currentChunkStartTime;
      const chunkDurationSeconds = Math.floor(chunkDurationMs / 1000);
      chunkCounter++;
      
      // Reset start time for next chunk
      currentChunkStartTime = Date.now();
      
      // Track in recording stats
      recordingStats.totalDuration += chunkDurationSeconds;
      recordingStats.chunks.push({
        number: chunkCounter,
        size: chunksToProcess.reduce((total, chunk) => total + chunk.size, 0),
        duration: chunkDurationSeconds,
        timestamp: new Date().toISOString()
      });
      
      // Log chunk details
      const chunkSizeKB = chunksToProcess.reduce((total, chunk) => total + chunk.size, 0) / 1024;
      console.log(`📦 Processing chunk #${chunkCounter}: ${chunkDurationSeconds}s, ${chunkSizeKB.toFixed(2)}KB`);
      
      // Show user notification
      showNotification(
        "Processing audio", 
        `Processing part ${chunkCounter} of the recording...`,
        "info"
      );
      
      // Process with timeout protection
      const processingPromise = new Promise((resolve, reject) => {
        // Set timeout for chunk processing
        const processingTimeout = setTimeout(() => {
          console.error("⏱️ Chunk processing timeout - continuing recording");
          resolve({ timedOut: true });
        }, CHUNK_CONFIG.processingTimeout);
        
        // Create blob from chunks
        const audioBlob = new Blob(chunksToProcess, {
          type: mediaRecorder?.mimeType || 'audio/webm'
        });
        
        // Convert to base64 for sending
        const reader = new FileReader();
        reader.onloadend = function() {
          if (reader.result) {
            const base64data = reader.result;
            recordingStats.lastNetworkActivity = new Date().toISOString();
            
            // Send to background script with chunk info
            chrome.runtime.sendMessage({
              type: "sendAudioToWhisper",
              file: base64data,
              meetingName: window.meetingName || meetingName || "Google Meet Call",
              chunkInfo: {
                number: chunkCounter,
                duration: chunkDurationSeconds,
                isLast: !continueRecording
              }
            }, (response) => {
              clearTimeout(processingTimeout);
              
              if (chrome.runtime.lastError) {
                console.error("❌ Error sending chunk:", chrome.runtime.lastError.message);
                showNotification(
                  "Processing error", 
                  "Failed to send audio for transcription: " + chrome.runtime.lastError.message,
                  "error"
                );
                reject(chrome.runtime.lastError);
                return;
              }
              
              if (response) {
                console.log("✅ Chunk processed:", response);
                
                if (response.status.includes("✅")) {
                  showNotification(
                    `Part ${chunkCounter} processed`, 
                    response.filename ? `File: ${response.filename}` : "File saved",
                    "success"
                  );
                } else {
                  showNotification(
                    "Processing issue", 
                    response.status + (response.error ? `: ${response.error}` : ""),
                    response.error ? "error" : "warning"
                  );
                }
                resolve(response);
              } else {
                console.warn("⚠️ No response from background script");
                reject(new Error("No response from background script"));
              }
            });
          } else {
            reject(new Error("FileReader result is null"));
          }
        };
        
        reader.onerror = function(error) {
          console.error("❌ Error reading audio blob:", error);
          clearTimeout(processingTimeout);
          reject(error);
        };
        
        reader.readAsDataURL(audioBlob);
      });
      
      // Wait for processing to complete or timeout
      await processingPromise;
      
    } catch (error) {
      console.error("❌ Error processing chunk:", error);
    } finally {
      // Complete processing and handle continuation
      completeChunkProcessing(continueRecording);
    }
  }
  
  /**
   * Complete chunk processing and handle the queue
   */
  function completeChunkProcessing(continueRecording) {
    // Reset processing flag
    isProcessingChunk = false;
    
    // Resume recording if needed
    if (continueRecording && mediaRecorder && mediaRecorder.state === "paused") {
      mediaRecorder.resume();
      console.log("▶ Recording resumed");
      
      // Set up the next chunk timer
      if (chunkTimer) clearTimeout(chunkTimer);
      chunkTimer = setTimeout(() => {
        if (isRecording && audioChunks.length > 0) {
          processCurrentChunk(true);
        }
      }, CHUNK_CONFIG.duration);
    }
    
    // Process any pending chunks
    if (pendingChunks.length > 0) {
      const nextChunk = pendingChunks.shift();
      console.log(`🔄 Processing next queued chunk (${pendingChunks.length} remaining)`);
      setTimeout(() => {
        processCurrentChunk(nextChunk.continueRecording);
      }, 1000); // Small delay to prevent immediate processing
    }
  }
  
  // =====================================================================
  // UI COMPONENTS AND NOTIFICATIONS
  // =====================================================================
  
  /**
   * Show recording indicator on screen
   */
  function showRecordingIndicator() {
    // Remove existing indicator if present
    hideRecordingIndicator();
    
    // Create indicator container
    const indicator = document.createElement('div');
    indicator.id = 'gtm-recording-indicator';
    indicator.className = 'gtm-recording-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 8px;
      left: 8px;
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 8px 12px;
      border-radius: 16px;
      font-size: 12px;
      display: flex;
      align-items: center;
      z-index: 9999;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      cursor: ${UI_CONFIG.allowDraggableIndicator ? 'move' : 'default'};
    `;
    
    // Add pulsing dot and text
    indicator.innerHTML = `
      <div class="gtm-recording-dot" style="
        width: 8px;
        height: 8px;
        background-color: #ea4335;
        border-radius: 50%;
        margin-right: 8px;
        animation: gtm-pulse 2s infinite;
      "></div>
      <span>Recording active${UI_CONFIG.showTimerInIndicator ? ' <span id="gtm-elapsed-time">00:00</span>' : ''}</span>
    `;
    
    // Add animation styles
    const style = document.createElement('style');
    style.textContent = `
      @keyframes gtm-pulse {
        0% {
          box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.7);
        }
        70% {
          box-shadow: 0 0 0 6px rgba(234, 67, 53, 0);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(234, 67, 53, 0);
        }
      }
      
      .gtm-recording-indicator.dragging {
        opacity: 0.8;
      }
    `;
    document.head.appendChild(style);
    
    // Add to page
    document.body.appendChild(indicator);
    
    // Make indicator draggable if enabled
    if (UI_CONFIG.allowDraggableIndicator) {
      makeElementDraggable(indicator);
    }
  }
  
  /**
   * Make an element draggable
   */
  function makeElementDraggable(element) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    
    element.onmousedown = dragMouseDown;
    
    function dragMouseDown(e) {
      e.preventDefault();
      // Get mouse position at startup
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      element.classList.add('dragging');
      
      // Add event listeners for mouse movement and release
      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }
    
    function elementDrag(e) {
      e.preventDefault();
      // Calculate new position
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;
      
      // Set new position
      element.style.top = (element.offsetTop - pos2) + "px";
      element.style.left = (element.offsetLeft - pos1) + "px";
    }
    
    function closeDragElement() {
      // Stop moving when mouse released
      element.classList.remove('dragging');
      document.onmouseup = null;
      document.onmousemove = null;
    }
  }
  
  /**
   * Start counting elapsed recording time
   */
  function startElapsedTimeCounter() {
    recordingStartTime = Date.now();
    
    if (elapsedTimeInterval) {
      clearInterval(elapsedTimeInterval);
    }
    
    // Only start if timer display is enabled
    if (UI_CONFIG.showTimerInIndicator) {
      elapsedTimeInterval = setInterval(updateElapsedTime, 1000);
    }
  }
  
  /**
   * Update elapsed time display
   */
  function updateElapsedTime() {
    const elapsedElement = document.getElementById('gtm-elapsed-time');
    if (!elapsedElement) return;
    
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const seconds = (elapsed % 60).toString().padStart(2, '0');
    
    elapsedElement.textContent = `${minutes}:${seconds}`;
  }
  
  /**
   * Stop elapsed time counter
   */
  function stopElapsedTimeCounter() {
    if (elapsedTimeInterval) {
      clearInterval(elapsedTimeInterval);
      elapsedTimeInterval = null;
    }
  }
  
  /**
   * Hide recording indicator
   */
  function hideRecordingIndicator() {
    const indicator = document.getElementById('gtm-recording-indicator');
    if (indicator) {
      indicator.remove();
    }
  }
  
  /**
   * Show notification to user
   */
  function showNotification(title, message, type = "info", duration = UI_CONFIG.notificationDuration) {
    // Check if notifications container exists
    let notificationContainer = document.getElementById('gtm-notification-container');
    
    if (!notificationContainer) {
      // Create container
      notificationContainer = document.createElement('div');
      notificationContainer.id = 'gtm-notification-container';
      notificationContainer.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 9999;
        width: 320px;
      `;
      document.body.appendChild(notificationContainer);
    }
    
    // Set colors based on notification type
    let typeColor;
    let bgColor;
    switch (type) {
      case "success":
        typeColor = "#0f9d58";
        bgColor = "#e6f4ea";
        break;
      case "warning":
        typeColor = "#f4b400";
        bgColor = "#fef7e0";
        break;
      case "error":
        typeColor = "#ea4335";
        bgColor = "#fce8e6";
        break;
      default:
        typeColor = "#1a73e8";
        bgColor = "#e8f0fe";
    }
    
    // Create notification
    const notification = document.createElement('div');
    notification.className = 'gtm-notification';
    notification.style.cssText = `
      background-color: ${bgColor};
      border-left: 4px solid ${typeColor};
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
      margin-bottom: 8px;
      overflow: hidden;
      animation: gtm-slide-in 0.3s ease-out;
    `;
    
    notification.innerHTML = `
      <div style="padding: 12px 16px;">
        <div style="display: flex; align-items: center; margin-bottom: 6px;">
          <div style="color: ${typeColor}; font-weight: 500; font-size: 14px;">
            ${title}
          </div>
          <button class="gtm-close-btn" style="background: none; border: none; cursor: pointer; margin-left: auto; color: #5f6368; font-size: 14px;">
            ✕
          </button>
        </div>
        <div style="color: #202124; font-size: 13px;">
          ${message}
        </div>
      </div>
    `;
    
    // Add animation styles if not already added
    if (!document.getElementById('gtm-notification-style')) {
      const style = document.createElement('style');
      style.id = 'gtm-notification-style';
      style.textContent = `
        @keyframes gtm-slide-in {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes gtm-slide-out {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
        
        .gtm-notification.slide-out {
          animation: gtm-slide-out 0.3s ease-in forwards;
        }
      `;
      document.head.appendChild(style);
    }
    
    // Add to container
    notificationContainer.appendChild(notification);
    
    // Close button handler
    const closeBtn = notification.querySelector('.gtm-close-btn');
    closeBtn.addEventListener('click', () => {
      notification.classList.add('slide-out');
      setTimeout(() => {
        if (notification.parentNode) {
          notification.remove();
        }
      }, 300);
    });
    
    // Auto-close
    setTimeout(() => {
      if (notification.parentNode) {
        notification.classList.add('slide-out');
        setTimeout(() => {
          if (notification.parentNode) {
            notification.remove();
          }
        }, 300);
      }
    }, duration);
  }
  
  /**
   * Disable auto-transcription for current meeting
   */
  function disableAutoTranscription() {
    autoTranscriptionEnabled = false;
    hasRequestedPermission = true; // Mark as already prompted
    
    if (isRecording) {
      stopRecording();
    }
    
    console.log("🔕 Auto-transcription disabled for current meeting");
    
    showNotification(
      "Transcription disabled", 
      "Auto-transcription disabled for this meeting",
      "info"
    );
    
    // Notify background script
    chrome.runtime.sendMessage({
      type: "autoTranscriptionDisabled",
      meetingName: meetingName,
      timestamp: new Date().toISOString()
    });
  }
  
  // =====================================================================
  // MESSAGE HANDLING
  // =====================================================================
  
  /**
   * Set up message handlers for popup and background communication
   */
  function setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      // Simple ping to check if content script is alive
      if (message.action === "ping") {
        console.log("📍 Received ping from popup");
        sendResponse({ 
          status: "pong", 
          available: true, 
          timestamp: new Date().toISOString() 
        });
        return true;
      }
      
      // Start recording request
      if (message.action === "startRecording") {
        console.log("📩 Received 'startRecording' message");
        hasRequestedPermission = true; // Mark as user-initiated
        
        startRecording().then(success => {
          sendResponse({ 
            status: success ? "✅ Recording started" : "❌ Failed to start recording",
            captureType: audioSource || "unknown",
            success: success
          });
        }).catch(error => {
          console.error("❌ Error in startRecording:", error);
          sendResponse({ 
            status: "❌ Recording error", 
            error: error.message,
            success: false
          });
        });
        
        return true; // For async response
      }
      
      // Stop recording request
      if (message.action === "stopRecording") {
        console.log("📩 Received 'stopRecording' message");
        
        stopRecording().then(success => {
          sendResponse({ 
            status: success ? "✅ Recording stopped" : "❌ No active recording",
            success: success
          });
        }).catch(error => {
          console.error("❌ Error in stopRecording:", error);
          sendResponse({ 
            status: "❌ Error stopping recording", 
            error: error.message,
            success: false
          });
        });
        
        return true; // For async response
      }
      
      // Disable auto-transcription request
      if (message.action === "disableAutoTranscription") {
        console.log("📩 Received 'disableAutoTranscription' message");
        disableAutoTranscription();
        sendResponse({ 
          status: "✅ Auto-transcription disabled",
          success: true
        });
      }
      
      // Get recording status request
      if (message.action === "getRecordingStatus") {
        sendResponse({ 
          isRecording: isRecording,
          meetingDetected: meetDetected,
          meetingName: window.meetingName || meetingName || "Unknown Meeting",
          hasRequestedPermission: hasRequestedPermission,
          audioSource: audioSource || "unknown",
          recordingStats: recordingStats,
          chunkCounter: chunkCounter,
          lastUpdate: new Date().toISOString()
        });
      }
      
      // Get diagnostic information
      if (message.action === "getDiagnostics") {
        sendResponse({
          audioSource: audioSource,
          meetingDetected: meetDetected,
          isRecording: isRecording,
          recordingStats: recordingStats,
          mediaRecorderState: mediaRecorder ? mediaRecorder.state : "not_initialized",
          mimeType: mediaRecorder ? mediaRecorder.mimeType : "unknown",
          browserInfo: {
            userAgent: navigator.userAgent,
            platform: navigator.platform
          }
        });
      }
      
      return true; // Important for async sendResponse
    });
  }
  
  // =====================================================================
  // RESOURCE MANAGEMENT
  // =====================================================================
  
  /**
   * Clean up resources when page is unloaded
   */
  function cleanupResources() {
    console.log("🧹 Cleaning up resources before page unload");
    
    // Stop observer if active
    if (meetingObserver) {
      meetingObserver.disconnect();
      meetingObserver = null;
    }
    
    // Stop recording if active
    if (isRecording && mediaRecorder && mediaRecorder.state !== "inactive") {
      try {
        mediaRecorder.stop();
      } catch (e) {
        console.error("❌ Error stopping recorder:", e);
      }
    }
    
    // Clear all timers
    if (chunkTimer) {
      clearTimeout(chunkTimer);
      chunkTimer = null;
    }
    
    if (memoryCheckTimer) {
      clearInterval(memoryCheckTimer);
      memoryCheckTimer = null;
    }
    
    if (elapsedTimeInterval) {
      clearInterval(elapsedTimeInterval);
      elapsedTimeInterval = null;
    }
    
    // Release media streams
    if (cachedAudioStream) {
      cachedAudioStream.getTracks().forEach(track => {
        try {
          track.stop();
        } catch (e) {
          console.warn("⚠️ Error stopping track:", e);
        }
      });
      cachedAudioStream = null;
    }
    
    console.log("✅ Resources cleanup completed");
  }
  
  // Initialize on load
  console.log("🚀 Google Meet Transcription Plugin loaded");