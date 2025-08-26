// @ts-check
/// <reference path="../types/chrome.d.ts" />
/// <reference path="../types/index.js" />


//*********** GLOBAL VARIABLES **********//
const reportErrorMessage = "There is a bug in TranscripTonic. Please report it at https://github.com/vivek-nexus/transcriptonic/issues"
/** @type {MutationObserverInit} */
const mutationConfig = { childList: true, attributes: true, subtree: true, characterData: true }

// Name of the person attending the meeting
let userName = "You"

// Transcript array that holds one or more transcript blocks
/** @type {TranscriptBlock[]} */
let transcript = []

// Buffer variables to dump values, which get pushed to transcript array as transcript blocks, at defined conditions
let personNameBuffer = "", transcriptTextBuffer = "", timestampBuffer = ""

// Chat update timing variables
let lastChatUpdateTime = 0
let chatUpdateTimeout = null
let pendingChatUpdates = []
const CHAT_UPDATE_DELAY = 5000 // 5 seconds
//Silence Threshold

// Chat messages array that holds one or more chat messages of the meeting
/** @type {ChatMessage[]} */
let chatMessages = []

// Tags storage for transcript blocks
let transcriptTags = new Map() // Map of transcript index to array of tags

// Capture meeting start timestamp, stored in ISO format
let meetingStartTimestamp = new Date().toISOString()
let meetingTitle = document.title

// Capture invalid transcript and chatMessages DOM element error for the first time and silence for the rest of the meeting to prevent notification noise
let isTranscriptDomErrorCaptured = false
let isChatMessagesDomErrorCaptured = false

// Capture meeting begin to abort userName capturing interval
let hasMeetingStarted = false

// Capture meeting end to suppress any errors
let hasMeetingEnded = false

// Real-time transcript display elements
let transcriptDisplayContainer = null
let transcriptDisplayContent = null
let isTranscriptDisplayVisible = false
let _updateRaf = null

// Efficient rendering state management
let lastRenderedTranscriptLength = 0
let liveMessageElement = null
let lastLiveUpdateTime = 0
let liveUpdateDebounceId = null
const LIVE_UPDATE_DEBOUNCE_MS = 300  // Update every 300ms max
const LIVE_UPDATE_MIN_INTERVAL_MS = 100  // Minimum interval between updates

// Storage debouncing variables
let _saveKeys = new Set()
let _saveSendDownload = false
let _saveRaf = null

// Monitoring variables
let monitorIntervalId = null

// Filler words and content filtering
const FILLER_WORDS = ['um', 'uh', 'er', 'ah', 'you know', 'like', 'so', 'well', 'actually', 'basically', 'literally', 'right', 'okay', 'alright']
const MIN_TRANSCRIPT_LENGTH = 15
const CONSOLIDATION_DELAY = 2000 // 2 seconds

// Consolidation timer
let consolidationTimer = null



let canUseAriaBasedTranscriptSelector = true






// Attempt to recover last meeting, if any. Abort if it takes more than 2 seconds to prevent current meeting getting messed up.
Promise.race([
  recoverLastMeeting(),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Recovery timed out')), 2000)
  )
]).
  catch((error) => {
    console.error(error)
  }).
  finally(() => {
    // Load transcript tags from storage and migrate to new structure
    chrome.storage.local.get(["transcriptTags"], function(result) {
      if (result.transcriptTags) {
        transcriptTags = new Map(result.transcriptTags)
        console.log('Loaded transcript tags:', transcriptTags.size, 'entries')
        
        // Migrate existing tags to transcript entries
        transcriptTags.forEach((tags, blockIndex) => {
          if (transcript[blockIndex]) {
            transcript[blockIndex].tags = tags
          }
        })
        
        // Save migrated data
        overWriteChromeStorageDebounced(["transcript"], false)
        console.log('Migrated tags to transcript entries')
      }
    })
    
    // Ensure all transcript entries have tags and notes arrays
    transcript.forEach((entry, index) => {
      if (!entry.tags) {
        entry.tags = []
        console.log('Added tags array to entry', index)
      }
      if (!entry.notes) {
        entry.notes = []
        console.log('Added notes array to entry', index)
      }
    })
    
    if (transcript.length > 0) {
      console.log('Ensured all transcript entries have tags and notes arrays')
      console.log('Current transcript structure:', transcript)
    }
    
    // Save current meeting data to chrome storage once recovery is complete or is aborted
    overWriteChromeStorageDebounced(["meetingStartTimestamp", "meetingTitle", "transcript", "chatMessages"], false)
  })




//*********** MAIN FUNCTIONS **********//
// Initialize extension directly without external status checks
meetingRoutines(2)


/**
 * @param {number} uiType
 */
function meetingRoutines(uiType) {
  const meetingEndIconData = {
    selector: "",
    text: ""
  }
  const captionsIconData = {
    selector: "",
    text: ""
  }
  // Different selector data for different UI versions
  switch (uiType) {
    case 1:
      meetingEndIconData.selector = ".google-material-icons"
      meetingEndIconData.text = "call_end"
      captionsIconData.selector = ".material-icons-extended"
      captionsIconData.text = "closed_caption_off"
      break
    case 2:
      meetingEndIconData.selector = ".google-symbols"
      meetingEndIconData.text = "call_end"
      captionsIconData.selector = ".google-symbols"
      captionsIconData.text = "closed_caption_off"
    default:
      break
  }

  // CRITICAL DOM DEPENDENCY. Wait until the meeting end icon appears, used to detect meeting start
  waitForElement(meetingEndIconData.selector, meetingEndIconData.text).then(() => {
    console.log("Meeting started")
    /** @type {ExtensionMessage} */
    const message = {
      type: "new_meeting_started"
    }
    chrome.runtime.sendMessage(message, function () { })
    hasMeetingStarted = true


      //*********** MEETING START ROUTINES **********//
      // Pick up meeting name after a delay, since Google meet updates meeting name after a delay
      setTimeout(() => updateMeetingTitle(), 5000)

    // Show transcript display automatically when meeting starts
    showRealtimeTranscriptDisplay()

    // Create real-time transcript display
    createRealtimeTranscriptDisplay()

    // Add keyboard shortcut listener (Ctrl/Cmd + Shift + T)
    const _toggleHandler = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 't') {
        event.preventDefault()
        if (isTranscriptDisplayVisible) {
          hideRealtimeTranscriptDisplay()
        } else {
          showRealtimeTranscriptDisplay()
        }
      }
    }
    document.removeEventListener('keydown', _toggleHandler)
    document.addEventListener('keydown', _toggleHandler)
    /** @type {MutationObserver} */
    let transcriptObserver
    /** @type {MutationObserver} */
    let chatMessagesObserver

    // Disconnect observers on tab close to prevent leaks
    window.addEventListener('beforeunload', () => {
      try { transcriptObserver && transcriptObserver.disconnect() } catch(e) {}
      try { chatMessagesObserver && chatMessagesObserver.disconnect() } catch(e) {}
      // Clean up chat timeout
      if (chatUpdateTimeout) {
        clearTimeout(chatUpdateTimeout)
        chatUpdateTimeout = null
      }
    })

    // **** REGISTER TRANSCRIPT LISTENER **** //
    try {
      // CRITICAL DOM DEPENDENCY
      const captionsButton = selectElements(captionsIconData.selector, /(closed_caption_off|closed_caption)/)[0]
      console.log("Captions button found:", !!captionsButton)

      // Click captions icon for non manual operation modes. Async operation.
      chrome.storage.sync.get(["operationMode"], function (resultSyncUntyped) {
        const resultSync = /** @type {ResultSync} */ (resultSyncUntyped)
        if (resultSync.operationMode === "manual") {
          console.log("Manual mode selected, leaving transcript off")
        } else {
          console.log("Auto mode - clicking captions button")
          captionsButton.click()
        }
      })

      // CRITICAL DOM DEPENDENCY. Grab the transcript element. This element is present, irrespective of captions ON/OFF, so this executes independent of operation mode.
      let transcriptTargetNode = document.querySelector(`div[role="region"][tabindex="0"]`)
      console.log("Aria-based transcript node found:", !!transcriptTargetNode)

      // For old captions UI
      if (!transcriptTargetNode) {
        transcriptTargetNode = document.querySelector(".a4cQT")
        canUseAriaBasedTranscriptSelector = false
        console.log("Old captions UI transcript node found:", !!transcriptTargetNode)
      }

      if (transcriptTargetNode) {
        console.log("Transcript target node found, setting up observer")
        // Attempt to dim down the transcript
        canUseAriaBasedTranscriptSelector
          ? transcriptTargetNode.setAttribute("style", "opacity:0.2")
          : transcriptTargetNode.children[1].setAttribute("style", "opacity:0.2")

      // Create transcript observer instance linked to the callback function. Registered irrespective of operation mode, so that any visible transcript can be picked up during the meeting, independent of the operation mode.
        transcriptObserver = new MutationObserver(transcriptMutationCallback)

      // Start observing the transcript element and chat messages element for configured mutations
      transcriptObserver.observe(transcriptTargetNode, mutationConfig)
      }
      else {
        throw new Error("Transcript element not found in DOM")
      }
    } catch (err) {
      console.error(err)
      isTranscriptDomErrorCaptured = true
      showNotification({ status: 400, message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" })

      logError("001", err)
    }

    // **** REGISTER CHAT MESSAGES LISTENER **** //
    try {
      const chatMessagesButton = selectElements(".google-symbols", "chat")[0]
      // Force open chat messages to make the required DOM to appear. Otherwise, the required chatMessages DOM element is not available.
      chatMessagesButton.click()

      // Allow DOM to be updated, close chat messages and then register chatMessage mutation observer
      waitForElement(`div[aria-live="polite"].Ge9Kpc`).then(() => {
        chatMessagesButton.click()
        // CRITICAL DOM DEPENDENCY. Grab the chat messages element. This element is present, irrespective of chat ON/OFF, once it appears for this first time.
        try {
          const chatMessagesTargetNode = document.querySelector(`div[aria-live="polite"].Ge9Kpc`)

          // Create chat messages observer instance linked to the callback function. Registered irrespective of operation mode.
          if (chatMessagesTargetNode) {
            chatMessagesObserver = new MutationObserver(chatMessagesMutationCallback)
          chatMessagesObserver.observe(chatMessagesTargetNode, mutationConfig)
          }
          else {
            throw new Error("Chat messages element not found in DOM")
          }
        } catch (err) {
          console.error(err)
          isChatMessagesDomErrorCaptured = true
          showNotification({ 
            status: 400, 
            message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" 
          })

          logError("002", err)
        }
      })
    } catch (err) {
      console.error(err)
      isChatMessagesDomErrorCaptured = true
      showNotification({ 
        status: 400, 
        message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" 
      })

      logError("003", err)
    }

      // Show confirmation message once observation has started, based on operation mode
    if (!isTranscriptDomErrorCaptured && !isChatMessagesDomErrorCaptured) {
      chrome.storage.sync.get(["operationMode"], function (resultSyncUntyped) {
        const resultSync = /** @type {ResultSync} */ (resultSyncUntyped)
        if (resultSync.operationMode === "manual") {
          showNotification({ status: 400, message: "<strong>TranscripTonic is not running</strong> <br /> Turn on captions using the CC icon, if needed" })
        }
        else {
          showNotification({ status: 200, message: "<strong>TranscripTonic is running</strong> <br /> Do not turn off captions" })
        }
      })
    }

      //*********** MEETING END ROUTINES **********//
    try {
      // CRITICAL DOM DEPENDENCY. Event listener to capture meeting end button click by user
      selectElements(meetingEndIconData.selector, meetingEndIconData.text)[0].parentElement.parentElement.addEventListener("click", () => {
          // To suppress further errors
        hasMeetingEnded = true
          if (transcriptObserver) {
          transcriptObserver.disconnect()
          }
          if (chatMessagesObserver) {
          chatMessagesObserver.disconnect()
        }

        // Push any data in the buffer variables to the transcript array, but avoid pushing blank ones. Needed to handle one or more speaking when meeting ends.
        if ((personNameBuffer !== "") && (transcriptTextBuffer !== "")) {
          pushBufferToTranscript()
        }
          // Save to chrome storage and send message to download transcript from background script
        overWriteChromeStorageDebounced(["transcript", "chatMessages"], true)

        // Clean up monitoring intervals
        if (monitorIntervalId) {
          clearInterval(monitorIntervalId)
          monitorIntervalId = null
        }

        // Hide real-time transcript display when meeting ends
        setTimeout(() => hideRealtimeTranscriptDisplay(), 2000)
      })
    } catch (err) {
      console.error(err)
      showNotification({ 
        status: 400, 
        message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" 
      })

      logError("004", err)
    }
  })
}


//*********** CALLBACK FUNCTIONS **********//
// Callback function to execute when transcription mutations are observed. 
/**
 * @param {MutationRecord[]} mutationsList
 */
function transcriptMutationCallback(mutationsList) {
  console.log("Transcript mutation callback triggered, mutations:", mutationsList.length)
  mutationsList.forEach(() => {
    try {
      // CRITICAL DOM DEPENDENCY. Get all people in the transcript
      const people = canUseAriaBasedTranscriptSelector
        ? document.querySelector(`div[role="region"][tabindex="0"]`)?.children
        : document.querySelector(".a4cQT")?.childNodes[1]?.firstChild?.childNodes

      console.log("People found in transcript:", people ? people.length : 0)

      if (people) {
        /// In aria based selector case, the last people element is "Jump to bottom" button. So, pick up only if more than 1 element is available.
        if (canUseAriaBasedTranscriptSelector ? (people.length > 1) : (people.length > 0)) {
          // Get the last person
          const person = canUseAriaBasedTranscriptSelector
            ? people[people.length - 2]
            : people[people.length - 1]
          // CRITICAL DOM DEPENDENCY
          const currentPersonName = person.childNodes[0].textContent
          // CRITICAL DOM DEPENDENCY
          const currentTranscriptText = person.childNodes[1].textContent

          if (currentPersonName && currentTranscriptText) {
            // Starting fresh in a meeting or resume from no active transcript
            if (transcriptTextBuffer === "") {
              personNameBuffer = currentPersonName
              timestampBuffer = new Date().toISOString()
              transcriptTextBuffer = currentTranscriptText
            }
            // Some prior transcript buffer exists
            else {
              // New person started speaking 
                if (personNameBuffer !== currentPersonName) {
                  // Finalize previous speaker's block
                  pushBufferToTranscript()

                  // ALSO: publish any queued chat immediately on speaker change
                  if (pendingChatUpdates.length > 0) {
                    processPendingChatUpdates()
                  }

                  // Update buffers for next mutation and store transcript block timestamp
                  personNameBuffer = currentPersonName
                  timestampBuffer = new Date().toISOString()
                  transcriptTextBuffer = currentTranscriptText
                }

              // Same person speaking more
  else {
                if (canUseAriaBasedTranscriptSelector) {
                  // When the same person speaks for more than 30 min (approx), Meet drops very long transcript for current person and starts over, which is detected by current transcript string being significantly smaller than the previous one
                  if ((currentTranscriptText.length - transcriptTextBuffer.length) < -250) {
                    // Push the long transcript
                    pushBufferToTranscript()

                    // Store transcript block timestamp for next transcript block of same person
                    timestampBuffer = new Date().toISOString()
                  }
                }
                else {
                  // If a person is speaking for a long time, Google Meet does not keep the entire text in the spans. Starting parts are automatically removed in an unpredictable way as the length increases and TranscripTonic will miss them. So we force remove a lengthy transcript node in a controlled way. Google Meet will add a fresh person node when we remove it and continue transcription. TranscripTonic picks it up as a new person and nothing is missed.
                  if (currentTranscriptText.length > 250) {
                    person.remove()
                  }
                }

                // Update buffers for next mutation. This has to be done irrespective of any condition.
                transcriptTextBuffer = currentTranscriptText
              }
            }
          }
        }
        // No people found in transcript DOM
        else {
          // No transcript yet or the last person stopped speaking(and no one has started speaking next)
          console.log("No active transcript - no people found in DOM")
          
          // Force final update of live bubble before clearing buffers
          if ((personNameBuffer !== "") && (transcriptTextBuffer !== "")) {
            // Cancel any pending debounced updates and force immediate update
            if (liveUpdateDebounceId) {
              clearTimeout(liveUpdateDebounceId)
              liveUpdateDebounceId = null
            }
            updateLiveElementNow() // Capture final words
            
            // Push data in the buffer variables to the transcript array
            pushBufferToTranscript()
          }
          
          // Update buffers for the next person in the next mutation
          personNameBuffer = ""
          transcriptTextBuffer = ""
          
          // User stopped speaking - process pending chat updates
          if (pendingChatUpdates.length > 0) {
            console.log("User stopped speaking, processing pending chat updates")
            processPendingChatUpdates()
          }
        }
      }

      // Update real-time transcript display
      updateRealtimeTranscriptDisplay()

      // Track user speech for test user responses and chat update timing
      if (personNameBuffer === "You" || personNameBuffer === userName) {
        lastUserSpeechTime = Date.now()
        lastChatUpdateTime = Date.now() // Update chat timing when user is speaking
      }

      // Logs to indicate that the extension is working
      if (transcriptTextBuffer.length > 125) {
        console.log(transcriptTextBuffer.slice(0, 50) + " ... " + transcriptTextBuffer.slice(-50))
  }
  else {
        console.log(transcriptTextBuffer)
      }
    } catch (err) {
      console.error(err)
      if (!isTranscriptDomErrorCaptured && !hasMeetingEnded) {
        console.log(reportErrorMessage)
        showNotification({ 
          status: 400, 
          message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" 
        })

        logError("005", err)
      }
      isTranscriptDomErrorCaptured = true
    }
  })
}

// Add pending chat update and manage timing
/**
 * @param {ChatMessage} chatBlock
 */
function addPendingChatUpdate(chatBlock) {
  // Clear existing timeout
  if (chatUpdateTimeout) {
    clearTimeout(chatUpdateTimeout)
  }

  // Add to pending updates (avoid duplicates)
  const isExisting = pendingChatUpdates.some(item =>
    item.personName === chatBlock.personName &&
    chatBlock.chatMessageText.includes(item.chatMessageText)
  )
  
  if (!isExisting) {
    pendingChatUpdates.push(chatBlock)
    console.log('Added pending chat update:', chatBlock.chatMessageText.substring(0, 50) + '...')
  }

  // Set new timeout for 5 seconds
  chatUpdateTimeout = setTimeout(() => {
    processPendingChatUpdates()
  }, CHAT_UPDATE_DELAY)

  // Update last activity time
  lastChatUpdateTime = Date.now()
}

// Process all pending chat updates
function processPendingChatUpdates() {
  if (pendingChatUpdates.length > 0) {
    console.log(`Processing ${pendingChatUpdates.length} pending chat updates`)
    
    // Add all pending updates to the main chat messages array
    pendingChatUpdates.forEach(chatBlock => {
      pushUniqueChatBlock(chatBlock)
    })

    // Clear pending updates
    pendingChatUpdates = []
    lastChatUpdateTime = Date.now()
  }

  // Clear the timeout
  chatUpdateTimeout = null
}


// Callback function to execute when chat messages mutations are observed. 
/**
 * @param {MutationRecord[]} mutationsList
 */
function chatMessagesMutationCallback(mutationsList) {
  mutationsList.forEach(() => {
    try {
      // CRITICAL DOM DEPENDENCY
      const chatMessagesElement = document.querySelector(`div[aria-live="polite"].Ge9Kpc`)
      // Attempt to parse messages only if at least one message exists
      if (chatMessagesElement && chatMessagesElement.children.length > 0) {
        // CRITICAL DOM DEPENDENCY. Get the last message that was sent/received.
        const chatMessageElement = chatMessagesElement.lastChild
        // CRITICAL DOM DEPENDENCY
        const personName = chatMessageElement?.firstChild?.firstChild?.textContent
        const timestamp = new Date().toISOString()
        // CRITICAL DOM DEPENDENCY. Some mutations will have some noisy text at the end, which is handled in pushUniqueChatBlock function.
        const chatMessageText = chatMessageElement?.lastChild?.lastChild?.textContent

        if (personName && chatMessageText) {
          /**@type {ChatMessage} */
          const chatMessageBlock = {
            "personName": personName === "You" ? userName : personName,
            "timestamp": timestamp,
            "chatMessageText": chatMessageText
          }

          // Queue it: we will publish after 5s of quiet or on speaker change
          addPendingChatUpdate(chatMessageBlock)

        }
      }
    }
    catch (err) {
      console.error(err)
      if (!isChatMessagesDomErrorCaptured && !hasMeetingEnded) {
        console.log(reportErrorMessage)
        showNotification({ 
          status: 400, 
          message: "<strong>TranscripTonic encountered an error</strong> <br /> Please check the console for details" 
        })

        logError("006", err)
      }
      isChatMessagesDomErrorCaptured = true
    }
  })
}










//*********** HELPER FUNCTIONS **********//
// Pushes data in the buffer to transcript array as a transcript block
// Helper function to check if text is only filler words
function isOnlyFillerWords(text) {
  const words = text.toLowerCase().trim().split(/\s+/)
  if (words.length === 0) return true

  return words.every(word => {
    const cleanWord = word.replace(/[.,!?;:]/g, '')
    return FILLER_WORDS.includes(cleanWord)
  })
}

// Helper function to check if content should be filtered
function shouldFilterContent(text) {
  // Filter if too short
  if (text.length < MIN_TRANSCRIPT_LENGTH) return true

  // Filter if only filler words
  if (isOnlyFillerWords(text)) return true

  // Filter if less than 3 words
  const wordCount = text.trim().split(/\s+/).length
  if (wordCount < 3) return true

  return false
}

function pushBufferToTranscript() {
  // Apply content filtering
  if (shouldFilterContent(transcriptTextBuffer)) {
    console.log('Filtered out short/filler content:', transcriptTextBuffer)
    return
  }

  const newEntry = {
    "personName": personNameBuffer === "You" ? userName : personNameBuffer,
    "timestamp": timestampBuffer,
    "transcriptText": transcriptTextBuffer,
    "tags": [],
    "notes": []
  }

  console.log('Creating new transcript entry:', newEntry)

  // Check for consolidation with previous entry
  const lastEntry = transcript[transcript.length - 1]
  const now = Date.now()

  if (lastEntry &&
      lastEntry.personName === newEntry.personName &&
      (now - new Date(lastEntry.timestamp).getTime()) < CONSOLIDATION_DELAY) {
    // Consolidate with previous entry
    lastEntry.transcriptText += ' ' + newEntry.transcriptText
    lastEntry.timestamp = newEntry.timestamp // Update to latest timestamp
    
    // Ensure tags and notes arrays exist
    if (!lastEntry.tags) lastEntry.tags = []
    if (!lastEntry.notes) lastEntry.notes = []
    
    console.log('Consolidated transcript entry:', lastEntry)
  } else {
    // Add as new entry
    transcript.push(newEntry)
    console.log('Added new transcript entry. Total entries:', transcript.length)
  }

  overWriteChromeStorageDebounced(["transcript"], false)
  updateRealtimeTranscriptDisplay()

  // Monitor for test user response opportunity
  setTimeout(monitorUserSpeech, 100)
}

// Creates and shows the real-time transcript display window
function createRealtimeTranscriptDisplay() {
  if (transcriptDisplayContainer) return

  // Reset rendering state for fresh start
  lastRenderedTranscriptLength = 0
  liveMessageElement = null
  lastLiveUpdateTime = 0
  if (liveUpdateDebounceId) {
    clearTimeout(liveUpdateDebounceId)
    liveUpdateDebounceId = null
  }

  // Create the main container
  transcriptDisplayContainer = document.createElement('div')
  transcriptDisplayContainer.id = 'transcriptonic-realtime-display'
  transcriptDisplayContainer.innerHTML = `
    <div class="transcriptonic-header">
      <div class="transcriptonic-title">
        <span>💬 Meeting Transcript</span>
        <span class="transcriptonic-count">${transcript.length} messages</span>
      </div>
      <div class="transcriptonic-controls">
        <button class="transcriptonic-toggle-btn" title="Minimize/Expand">−</button>
        <button class="transcriptonic-close-btn" title="Close">×</button>
      </div>
    </div>
    <div class="transcriptonic-content" id="transcriptonic-content">
      <div class="transcriptonic-empty">Waiting for transcript...</div>
    </div>
  `

  // Add styles
  const style = document.createElement('style')
  style.textContent = `
    #transcriptonic-realtime-display {
      will-change: transform;
    position: fixed;
      top: 24px;
      right: 24px;
      width: 420px;
      max-height: calc(100vh - 48px);
      background: #fcfbf8;
      backdrop-filter: blur(24px);
      border: 1px solid rgba(216, 214, 207, 0.4);
      border-radius: 20px;
      box-shadow:
        0 32px 64px rgba(0, 0, 0, 0.08),
        0 16px 32px rgba(0, 0, 0, 0.04),
        inset 0 1px 0 rgba(255, 255, 255, 0.9);
      z-index: 10000;
      font-family: 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      color: #1e293b;
      font-size: 14px;
      overflow: hidden;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }

    .transcriptonic-header {
      user-select: none;
    display: flex; 
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
      border-bottom: 1px solid rgba(226, 232, 240, 0.8);
      border-radius: 20px 20px 0 0;
    }

    .transcriptonic-title {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 600;
      color: #1e293b;
      font-size: 16px;
      letter-spacing: -0.2px;
    }

    .transcriptonic-title span:first-child {
      font-size: 20px;
      color: #2d2d2d;
    }

    .transcriptonic-count {
      background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
      color: #475569;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: -0.1px;
      box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
    }

    .transcriptonic-controls {
      display: flex;
      gap: 8px;
    }

    .transcriptonic-toggle-btn,
    .transcriptonic-close-btn {
      background: rgba(255, 255, 255, 0.8);
      border: 1px solid rgba(226, 232, 240, 0.6);
      color: #64748b;
      cursor: pointer;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      align-items: center;
    justify-content: center; 
      backdrop-filter: blur(10px);
    }

    .transcriptonic-toggle-btn:hover,
    .transcriptonic-close-btn:hover {
      background: rgba(255, 255, 255, 1);
      color: #1e293b;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
      border-color: rgba(203, 213, 225, 0.8);
    }

    .transcriptonic-content {
      max-height: calc(100vh - 140px);
      overflow-y: auto;
      padding: 8px;
      background: #fcfbf8;
    }

    .transcriptonic-content.collapsed {
      display: none;
    }

    .transcriptonic-empty {
      text-align: center;
      color: #94a3b8;
      font-style: italic;
      padding: 60px 24px;
      font-size: 15px;
      background: radial-gradient(circle, rgba(148, 163, 184, 0.05) 0%, transparent 70%);
      border-radius: 12px;
      margin: 16px;
    }

    .transcriptonic-block {
      padding: 20px;
      margin: 8px;
      border-radius: 16px;
      transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
      cursor: default;
      background: #f8f3ec;
      border: 1px solid rgba(216, 214, 207, 0.3);
      backdrop-filter: blur(10px);
      opacity: 0;
      transform: translateY(20px) scale(0.98);
      animation: premiumSlideIn 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      position: relative;
      overflow: hidden;
    }

    .transcriptonic-block::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(216, 214, 207, 0.05), transparent);
      transition: left 0.6s ease;
    }

    .transcriptonic-block:hover::before {
      left: 100%;
    }

    @keyframes premiumSlideIn {
      0% {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      60% {
        transform: translateY(-2px) scale(1.01);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .transcriptonic-block:hover {
      background: #d8d6cf;
      transform: translateY(-2px) scale(1.02);
      box-shadow:
        0 16px 32px rgba(0, 0, 0, 0.06),
        0 8px 16px rgba(0, 0, 0, 0.03);
      border-color: rgba(216, 214, 207, 0.5);
    }



    .transcriptonic-block:last-child {
      border-bottom: none;
    }

    .transcriptonic-speaker {
      font-weight: 600;
      color: #1e293b;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
    align-items: center; 
      font-size: 15px;
      letter-spacing: -0.2px;
    }

    .transcriptonic-speaker-info {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .transcriptonic-speaker-title {
      font-size: 12px;
      color: #64748b;
      font-weight: 400;
      margin-left: 4px;
    }

    .transcriptonic-time {
      font-size: 12px;
      color: #94a3b8;
      font-weight: 400;
      letter-spacing: -0.1px;
    }

    .transcriptonic-text {
      line-height: 1.6;
      color: #334155;
      font-size: 14px;
      word-wrap: break-word;
      margin-bottom: 12px;
    }

    .transcriptonic-text {
      position: relative;
      line-height: 1.6;
      color: #334155;
      font-size: 14px;
      word-wrap: break-word;
      margin-bottom: 12px;
    }

    .transcriptonic-floating-actions {
      position: absolute;
      top: -8px;
      right: -8px;
      display: flex;
      gap: 4px;
      opacity: 0;
      transform: translateY(4px) scale(0.9);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(12px);
      border-radius: 12px;
      padding: 4px;
      border: 1px solid rgba(216, 214, 207, 0.3);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
    }

    .transcriptonic-block:hover .transcriptonic-floating-actions {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    .transcriptonic-action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(216, 214, 207, 0.4);
      border-radius: 8px;
      cursor: pointer;
      color: #64748b;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      backdrop-filter: blur(10px);
    }

    .transcriptonic-action-btn:hover {
      background: rgba(255, 255, 255, 0.9);
      border-color: rgba(216, 214, 207, 0.6);
      color: #2d2d2d;
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
    }

    .transcriptonic-action-btn svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 1.5;
    }

    .transcriptonic-current {
      background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
      border: 2px solid #0ea5e9;
      box-shadow:
        0 8px 24px rgba(14, 165, 233, 0.1),
        0 4px 12px rgba(14, 165, 233, 0.05);
    }

    .transcriptonic-current .transcriptonic-speaker {
      color: #0369a1;
    }

    .transcriptonic-current .transcriptonic-text {
      color: #1e293b;
    }

    .transcriptonic-typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: 8px;
    }

    .transcriptonic-typing-dot {
      width: 4px;
      height: 4px;
      background: #0ea5e9;
      border-radius: 50%;
      animation: typingPulse 1.4s infinite ease-in-out;
    }

    .transcriptonic-typing-dot:nth-child(2) {
      animation-delay: 0.2s;
    }

    .transcriptonic-typing-dot:nth-child(3) {
      animation-delay: 0.4s;
    }

    @keyframes typingPulse {
      0%, 60%, 100% {
        transform: scale(1);
        opacity: 0.5;
      }
      30% {
        transform: scale(1.2);
        opacity: 1;
      }
    }

    /* Dynamic bubble styles */
    .dynamic-bubble {
      margin: 4px 8px 8px 8px;
      padding: 16px 20px;
      background: rgba(45, 45, 45, 0.05);
      border: 1px solid rgba(45, 45, 45, 0.15);
      border-radius: 12px;
      opacity: 0;
      transform: translateY(10px) scale(0.95);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      animation: dynamicBubbleSlideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
      position: relative;
      backdrop-filter: blur(5px);
    }

    .dynamic-bubble::before {
      content: '';
      position: absolute;
      top: -8px;
      left: 20px;
      width: 0;
      height: 0;
      border-left: 8px solid transparent;
      border-right: 8px solid transparent;
      border-bottom: 8px solid rgba(45, 45, 45, 0.05);
    }

    .dynamic-bubble::after {
      content: '';
      position: absolute;
      top: -7px;
      left: 21px;
      width: 0;
      height: 0;
      border-left: 6px solid transparent;
      border-right: 6px solid transparent;
      border-bottom: 6px solid rgba(45, 45, 45, 0.05);
    }

    @keyframes dynamicBubbleSlideIn {
      0% {
        opacity: 0;
        transform: translateY(10px) scale(0.95);
      }
      100% {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .note-textarea, .edit-textarea {
      width: 100%;
      min-height: 60px;
      padding: 12px;
      border: 1px solid rgba(216, 214, 207, 0.5);
      border-radius: 8px;
      background: #fcfbf8;
      color: #2d2d2d;
      font-size: 14px;
      font-family: inherit;
      resize: vertical;
      outline: none;
      transition: all 0.2s ease;
      margin-top: 8px;
    }

    .note-textarea:focus, .edit-textarea:focus {
      border-color: rgba(45, 45, 45, 0.3);
      box-shadow: 0 0 0 3px rgba(45, 45, 45, 0.1);
    }

    .action-buttons {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      justify-content: flex-end;
    }

    .save-btn, .cancel-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      border: 1px solid rgba(216, 214, 207, 0.5);
    }

    .save-btn {
      background: #2d2d2d;
    color: white;
      border-color: #2d2d2d;
    }

    .save-btn:hover {
      background: #1a1a1a;
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(45, 45, 45, 0.2);
    }

    .cancel-btn {
      background: #fcfbf8;
      color: #64748b;
    }

    .cancel-btn:hover {
      background: #d8d6cf;
      color: #2d2d2d;
    }

    /* Disable animations while patching DOM to avoid flicker */
    .no-anim, .no-anim * { animation: none !important; transition: none !important; }

    /* Scrollbar styling */
    .transcriptonic-content::-webkit-scrollbar {
      width: 8px;
    }

    .transcriptonic-content::-webkit-scrollbar-track {
      background: #fcfbf8;
      border-radius: 4px;
    }

    .transcriptonic-content::-webkit-scrollbar-thumb {
      background: #c8c6c4;
      border-radius: 4px;
    }

    .transcriptonic-content::-webkit-scrollbar-thumb:hover {
      background: #a19f9d;
    }

    /* Additional corporate styling */
    .transcriptonic-block:first-child {
      border-top: none;
    }

    .transcriptonic-speaker-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #0078d4;
      margin-right: 8px;
      flex-shrink: 0;
    }

    .transcriptonic-current .transcriptonic-speaker-indicator {
      background: #107c10;
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }

    /* Transparent speak icon */
    .transcriptonic-speak-icon {
      display: inline-flex;
      align-items: center;
      margin-left: 8px;
      opacity: 0.6;
    }

    .transcriptonic-speak-icon svg {
      width: 14px;
      height: 14px;
      stroke: #323130;
      fill: none;
      stroke-width: 1.5;
      animation: pulse 2s infinite;
    }

    /* Tag styles */
    .transcriptonic-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 8px 0;
    }

    .transcriptonic-tag {
      display: inline-block;
      background: linear-gradient(135deg, #e0f2fe 0%, #b3e5fc 100%);
      color: #0277bd;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid rgba(3, 169, 244, 0.2);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      transition: all 0.2s ease;
      cursor: default;
    }

    .transcriptonic-tag {
      display: inline-block;
      background: linear-gradient(135deg, #e0f2fe 0%, #b3e5fc 100%);
      color: #0277bd;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid rgba(3, 169, 244, 0.2);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      transition: all 0.2s ease;
      cursor: pointer;
      position: relative;
      padding-right: 20px;
    }

    .transcriptonic-tag:hover {
      background: linear-gradient(135deg, #b3e5fc 0%, #81d4fa 100%);
      transform: translateY(-1px);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
    }

    .transcriptonic-tag-remove {
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      width: 14px;
      height: 14px;
      background: rgba(239, 68, 68, 0.8);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.2s ease;
      opacity: 0;
    }

    .transcriptonic-tag:hover .transcriptonic-tag-remove {
      opacity: 1;
    }

    .transcriptonic-tag-remove:hover {
      background: rgba(239, 68, 68, 1);
      transform: translateY(-50%) scale(1.1);
    }

    /* Note styles */
    .transcriptonic-notes {
      margin: 8px 0;
    }

    .transcriptonic-note {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 8px 12px;
      background: rgba(255, 193, 7, 0.1);
      border: 1px solid rgba(255, 193, 7, 0.3);
      border-radius: 8px;
      margin: 4px 0;
      font-size: 12px;
      color: #856404;
    }

    .transcriptonic-note-icon {
      font-size: 14px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .transcriptonic-note-text {
      flex: 1;
      line-height: 1.4;
    }

    .transcriptonic-note-time {
      font-size: 10px;
      color: #856404;
      opacity: 0.7;
      flex-shrink: 0;
      margin-top: 1px;
    }
  `
  document.head.appendChild(style)

  // Get content element
  transcriptDisplayContent = transcriptDisplayContainer.querySelector('#transcriptonic-content')

  // Add event listeners
  const toggleBtn = transcriptDisplayContainer.querySelector('.transcriptonic-toggle-btn')
  const closeBtn = transcriptDisplayContainer.querySelector('.transcriptonic-close-btn')

  if (toggleBtn) toggleBtn.addEventListener('click', toggleRealtimeTranscriptDisplay)
  if (closeBtn)  closeBtn.addEventListener('click', hideRealtimeTranscriptDisplay)

  // Make the window draggable
  const header = transcriptDisplayContainer.querySelector('.transcriptonic-header')
  let isDragging = false
  let dragOffset = { x: 0, y: 0 }

  if (header) {
    header.addEventListener('mousedown', function(e) {
      const mouseEvent = /** @type {MouseEvent} */ (e)
      isDragging = true
      dragOffset.x = mouseEvent.clientX - transcriptDisplayContainer.offsetLeft
      dragOffset.y = mouseEvent.clientY - transcriptDisplayContainer.offsetTop
      const headerElement = /** @type {HTMLElement} */ (header)
      headerElement.style.cursor = 'grabbing'
    })
  }

  document.addEventListener('mousemove', function(e) {
    if (isDragging) {
      transcriptDisplayContainer.style.left = (e.clientX - dragOffset.x) + 'px'
      transcriptDisplayContainer.style.top = (e.clientY - dragOffset.y) + 'px'
      transcriptDisplayContainer.style.right = 'auto' // Remove right positioning
    }
  })

  document.addEventListener('mouseup', function() {
    isDragging = false
    if (header) {
      const headerElement = /** @type {HTMLElement} */ (header)
      headerElement.style.cursor = 'grab'
    }
  })

  if (header) {
    const headerElement = /** @type {HTMLElement} */ (header)
    headerElement.style.cursor = 'grab'
  }

  // Add to page
  document.body.appendChild(transcriptDisplayContainer)
  isTranscriptDisplayVisible = true

  // Initial update
  updateRealtimeTranscriptDisplay()

  // Show a brief notification
  console.log("TranscripTonic: Corporate-style meeting transcript display created. Use Ctrl/Cmd+Shift+T to toggle.")

  // Add test user immediately
  setTimeout(() => {
    addTestTranscriptBlock()
  }, 1000)

  // Start periodic monitoring for test user responses
  monitorIntervalId = monitorIntervalId || setInterval(monitorUserSpeech, 1000)
}

// Updates the real-time transcript display with current transcript data
function updateRealtimeTranscriptDisplay() {
  if (!transcriptDisplayContainer || !transcriptDisplayContent) {
    return
  }

  // Update count in header
  updateHeaderMessageCount()

  // Handle empty state
  if (transcript.length === 0 && transcriptTextBuffer === '') {
    if (!transcriptDisplayContent.querySelector('.transcriptonic-empty')) {
      transcriptDisplayContent.innerHTML = '<div class="transcriptonic-empty">Waiting for meeting transcript...</div>'
    }
    return
  }

  // Remove empty state if it exists
  const emptyState = transcriptDisplayContent.querySelector('.transcriptonic-empty')
  if (emptyState) {
    emptyState.remove()
  }

  // Add any new completed messages (append-only, never re-render existing)
  addNewCompletedMessages()

  // Update or create the live speaking bubble (debounced)
  updateLiveSpeakingBubble()

  // Auto-scroll only if user isn't interacting
  autoScrollIfNeeded()
}

function updateHeaderMessageCount() {
  const countElement = transcriptDisplayContainer.querySelector('.transcriptonic-count')
  if (countElement) {
    const messageCount = transcript.length + (transcriptTextBuffer ? 1 : 0)
    countElement.textContent = `${messageCount} message${messageCount !== 1 ? 's' : ''}`
  }
}

function addNewCompletedMessages() {
  // Only add messages that haven't been rendered yet
  const newMessageCount = transcript.length - lastRenderedTranscriptLength
  
  if (newMessageCount > 0) {
    console.log(`Adding ${newMessageCount} new completed messages`)
    
    for (let i = lastRenderedTranscriptLength; i < transcript.length; i++) {
      const block = transcript[i]
      const blockElement = createCompletedMessageElement(block, i)
      
      // Insert before live message if it exists, otherwise append
      if (liveMessageElement) {
        transcriptDisplayContent.insertBefore(blockElement, liveMessageElement)
      } else {
        transcriptDisplayContent.appendChild(blockElement)
      }
    }
    
    lastRenderedTranscriptLength = transcript.length
  }
}

function createCompletedMessageElement(block, index) {
  const blockElement = document.createElement('div')
  blockElement.className = 'transcriptonic-block'
  blockElement.setAttribute('data-block-index', index.toString())
  blockElement.style.animationDelay = `${index * 0.1}s`

  const timestamp = new Date(block.timestamp)
  const timeString = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const speakerTitle = block.personName === userName ? 'You' : 'Participant'

  blockElement.innerHTML = `
    <div class="transcriptonic-speaker">
      <div class="transcriptonic-speaker-info">
        <div class="transcriptonic-speaker-indicator"></div>
        <span>${block.personName}</span>
        <span class="transcriptonic-speaker-title">${speakerTitle}</span>
      </div>
      <span class="transcriptonic-time">${timeString}</span>
    </div>
    <div class="transcriptonic-text">
      ${block.transcriptText}
      <div class="transcriptonic-floating-actions">
        <div class="transcriptonic-action-btn" data-action="ai" data-index="${index}" title="AI Analysis">
          <svg viewBox="0 0 24 24">
            <path d="M12 2L2 7v10c0 5.55 3.84 10 9 11 5.16-1 9-5.45 9-11V7l-10-5z"/>
            <path d="M8 11l2 2 4-4"/>
          </svg>
        </div>
        <div class="transcriptonic-action-btn" data-action="edit" data-index="${index}" title="Edit Message">
          <svg viewBox="0 0 24 24">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3l-9.5 9.5-4 1 1-4 9.5-9.5z"/>
          </svg>
        </div>
        <div class="transcriptonic-action-btn" data-action="note" data-index="${index}" title="Add Note">
          <svg viewBox="0 0 24 24">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <path d="M10 9H8"/>
          </svg>
        </div>
        <div class="transcriptonic-action-btn" data-action="tag" data-index="${index}" title="Add Tag">
          <svg viewBox="0 0 24 24">
            <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 14V2h12v8.59a2 2 0 0 1 .59 1.41z"/>
            <path d="M7 7h.01"/>
          </svg>
        </div>
      </div>
    </div>
  `

  // Add event listeners for action buttons
  const actionButtons = blockElement.querySelectorAll('.transcriptonic-action-btn')
  actionButtons.forEach((button) => {
    button.addEventListener('click', function(e) {
      e.stopPropagation()
      const action = this.getAttribute('data-action')
      const index = parseInt(this.getAttribute('data-index'))

      // Visual feedback
      this.style.background = 'rgba(45, 45, 45, 0.1)'
      this.style.color = '#2d2d2d'
      setTimeout(() => {
        this.style.background = ''
        this.style.color = ''
      }, 200)

      handleActionClick(action, index)
    })
  })

  return blockElement
}

function updateLiveSpeakingBubble() {
  // If no buffer, remove live element immediately
  if (!transcriptTextBuffer || !personNameBuffer) {
    if (liveMessageElement) {
      liveMessageElement.remove()
      liveMessageElement = null
      lastLiveUpdateTime = 0
    }
    return
  }

  const currentTime = Date.now()
  
  // Always update if there's no live element yet
  if (!liveMessageElement) {
    updateLiveElementNow()
    lastLiveUpdateTime = currentTime
    return
  }

  // Check if enough time has passed since last update
  const timeSinceLastUpdate = currentTime - lastLiveUpdateTime
  
  if (timeSinceLastUpdate >= LIVE_UPDATE_MIN_INTERVAL_MS) {
    // Clear any pending debounced update
    if (liveUpdateDebounceId) {
      clearTimeout(liveUpdateDebounceId)
      liveUpdateDebounceId = null
    }
    
    // Update immediately
    updateLiveElementNow()
    lastLiveUpdateTime = currentTime
  } else {
    // Schedule a debounced update if not already scheduled
    if (!liveUpdateDebounceId) {
      const remainingTime = LIVE_UPDATE_MIN_INTERVAL_MS - timeSinceLastUpdate
      liveUpdateDebounceId = setTimeout(() => {
        updateLiveElementNow()
        lastLiveUpdateTime = Date.now()
        liveUpdateDebounceId = null
      }, remainingTime)
    }
  }
}

function updateLiveElementNow() {
  const timestamp = new Date(timestampBuffer || new Date().toISOString())
  const timeString = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const speakerName = personNameBuffer === "You" ? userName : personNameBuffer
  const speakerTitle = personNameBuffer === "You" ? 'You' : 'Speaking'

  const liveHTML = `
    <div class="transcriptonic-speaker">
      <div class="transcriptonic-speaker-info">
        <div class="transcriptonic-speaker-indicator"></div>
        <span>${speakerName}</span>
        <span class="transcriptonic-speaker-title">${speakerTitle}</span>
        <div class="transcriptonic-typing-indicator">
          <div class="transcriptonic-typing-dot"></div>
          <div class="transcriptonic-typing-dot"></div>
          <div class="transcriptonic-typing-dot"></div>
        </div>
      </div>
      <span class="transcriptonic-time">${timeString}</span>
    </div>
    <div class="transcriptonic-text">${transcriptTextBuffer}</div>
  `

  if (!liveMessageElement) {
    // Create new live element
    liveMessageElement = document.createElement('div')
    liveMessageElement.className = 'transcriptonic-block transcriptonic-current'
    transcriptDisplayContent.appendChild(liveMessageElement)
  }

  liveMessageElement.innerHTML = liveHTML
}

function autoScrollIfNeeded() {
  // Don't auto-scroll if user is actively interacting with dynamic bubbles
  const activeBubbles = transcriptDisplayContent.querySelectorAll('.dynamic-bubble')
  const hasActiveInput = Array.from(activeBubbles).some(bubble => {
    const textarea = bubble.querySelector('textarea')
    return textarea && textarea === document.activeElement
  })

  if (!hasActiveInput) {
    transcriptDisplayContent.scrollTop = transcriptDisplayContent.scrollHeight
  }
}

// Toggles the visibility of the transcript content
function toggleRealtimeTranscriptDisplay() {
  if (!transcriptDisplayContent) return

  const toggleBtn = transcriptDisplayContainer.querySelector('.transcriptonic-toggle-btn')
  const isCollapsed = transcriptDisplayContent.classList.contains('collapsed')

  if (isCollapsed) {
    transcriptDisplayContent.classList.remove('collapsed')
    if (toggleBtn) toggleBtn.textContent = '−'
  } else {
    transcriptDisplayContent.classList.add('collapsed')
    if (toggleBtn) toggleBtn.textContent = '+'
  }
}

// Hides the real-time transcript display
function hideRealtimeTranscriptDisplay() {
  if (transcriptDisplayContainer) {
    transcriptDisplayContainer.remove()
    transcriptDisplayContainer = null
    transcriptDisplayContent = null
    isTranscriptDisplayVisible = false
    
    // Reset rendering state
    lastRenderedTranscriptLength = 0
    liveMessageElement = null
    lastLiveUpdateTime = 0
    if (liveUpdateDebounceId) {
      clearTimeout(liveUpdateDebounceId)
      liveUpdateDebounceId = null
    }
    
    if (monitorIntervalId) { 
      clearInterval(monitorIntervalId) 
      monitorIntervalId = null 
    }
  }
}

// Shows the real-time transcript display
function showRealtimeTranscriptDisplay() {
  if (!isTranscriptDisplayVisible) {
    createRealtimeTranscriptDisplay()
  }
}

// Test user responses
const testUserResponses = [
  "Ok, I got your point",
  "That makes sense to me",
  "I understand what you're saying",
  "Good point, thanks for clarifying",
  "I see what you mean",
  "That's a great observation",
  "I agree with that approach",
  "Thanks for the explanation",
  "That sounds reasonable",
  "I'm following your logic"
]

let lastUserSpeechTime = 0
let testUserResponseTimer = null

// Test function to add a sample transcript block
function addTestTranscriptBlock() {
  console.log('Adding test transcript block...')
  console.log('Current transcript before adding:', transcript)

  transcript.push({
    "personName": "Alex Chen",
    "timestamp": new Date().toISOString(),
    "transcriptText": "Hi everyone! I'm here to help test the transcript system. Feel free to speak and I'll respond.",
    "tags": [],
    "notes": []
  })

  console.log('Current transcript after adding:', transcript)
  console.log('Calling updateRealtimeTranscriptDisplay...')
  updateRealtimeTranscriptDisplay()
  overWriteChromeStorage(["transcript"], false)
  console.log('Test block added, transcript length:', transcript.length)
}

// Function to add test user response
function addTestUserResponse() {
  const randomResponse = testUserResponses[Math.floor(Math.random() * testUserResponses.length)]

  transcript.push({
    "personName": "Alex Chen",
    "timestamp": new Date().toISOString(),
    "transcriptText": randomResponse
  })

  updateRealtimeTranscriptDisplay()
  overWriteChromeStorageDebounced(["transcript"], false)
  console.log('Test user responded:', randomResponse)
}

// Monitor for user speech completion
function monitorUserSpeech() {
  const currentTime = Date.now()

  // If user was speaking and now stopped (no buffer updates for 3 seconds)
  if (lastUserSpeechTime > 0 && (currentTime - lastUserSpeechTime) > 3000) {
    lastUserSpeechTime = 0

    // Clear any existing timer
    if (testUserResponseTimer) {
      clearTimeout(testUserResponseTimer)
    }

    // Add test user response after 2-4 seconds delay
    const delay = 2000 + Math.random() * 2000
    testUserResponseTimer = setTimeout(() => {
      addTestUserResponse()
    }, delay)
  }
}

// Dynamic bubble functions
function createDynamicBubble(parentBlock, actionType) {
  // Check if dynamic bubble already exists for this block
  const existingBubble = parentBlock.nextElementSibling
  if (existingBubble && existingBubble.classList.contains('dynamic-bubble')) {
    existingBubble.remove()
    return
  }

  const dynamicBubble = document.createElement('div')
  dynamicBubble.className = 'dynamic-bubble'

  if (actionType === 'Edit') {
    const originalText = parentBlock.querySelector('.transcriptonic-text').textContent
    dynamicBubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span style="font-weight: 600; color: #2d2d2d;">Edit Message</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Dynamic</span>
      </div>
      <textarea class="edit-textarea" placeholder="Edit the message text...">${originalText}</textarea>
      <div class="action-buttons">
        <button class="cancel-btn">Cancel</button>
        <button class="save-btn">Save Changes</button>
      </div>
    `
  } else if (actionType === 'Note') {
    dynamicBubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-weight: 600; color: #2d2d2d;">Add Note</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Dynamic</span>
      </div>
      <div style="margin-bottom: 8px; font-size: 12px; color: #64748b;">Attach a private note to this message</div>
      <textarea class="note-textarea" placeholder="Type your note here..."></textarea>
      <div class="action-buttons">
        <button class="cancel-btn">Cancel</button>
        <button class="save-btn">Save Note</button>
      </div>
    `
  } else if (actionType === 'AI') {
    dynamicBubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-weight: 600; color: #2d2d2d;">AI Analysis</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Dynamic</span>
      </div>
      <div style="margin-bottom: 8px; font-size: 12px; color: #64748b;">AI-powered insights and analysis</div>
      <div style="padding: 12px; background: rgba(45, 45, 45, 0.03); border-radius: 8px; font-size: 13px; color: #2d2d2d;">
        🤖 Analyzing transcript content... This feature will provide AI-powered insights, sentiment analysis, and key points extraction.
      </div>
      <div class="action-buttons">
        <button class="cancel-btn">Close</button>
      </div>
    `
  } else if (actionType === 'Tag') {
    const blockIndex = parentBlock.getAttribute('data-block-index')
    const existingTags = transcriptTags.get(parseInt(blockIndex)) || []
    const tagsText = existingTags.join(', ')
    
    dynamicBubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-weight: 600; color: #2d2d2d;">Add Tags</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Dynamic</span>
      </div>
      <div style="margin-bottom: 8px; font-size: 12px; color: #64748b;">Add tags separated by commas (e.g., important, action-item, follow-up)</div>
      <textarea class="note-textarea" placeholder="Type tags separated by commas...">${tagsText}</textarea>
      <div class="action-buttons">
        <button class="cancel-btn">Cancel</button>
        <button class="save-btn">Save Tags</button>
      </div>
    `
  } else {
    dynamicBubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-weight: 600; color: #2d2d2d;">Quick Response</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Dynamic</span>
      </div>
      <div style="margin-bottom: 8px; font-size: 12px; color: #64748b;">Send a quick response to this message</div>
      <textarea class="note-textarea" placeholder="Type your response..."></textarea>
      <div class="action-buttons">
        <button class="cancel-btn">Cancel</button>
        <button class="save-btn">Send Response</button>
      </div>
    `
  }

  // Insert after the parent block
  parentBlock.parentNode.insertBefore(dynamicBubble, parentBlock.nextSibling)

  // Add event listeners for buttons
  const cancelBtn = dynamicBubble.querySelector('.cancel-btn')
  const saveBtn = dynamicBubble.querySelector('.save-btn')

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => removeDynamicBubble(dynamicBubble))
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (actionType === 'Edit') {
        saveEdit(dynamicBubble, parentBlock)
      } else if (actionType === 'Note') {
        saveNote(dynamicBubble, parentBlock)
      } else if (actionType === 'Tag') {
        saveTags(dynamicBubble, parentBlock)
      } else {
        saveResponse(dynamicBubble, parentBlock)
      }
    })
  }

  // Focus on textarea if it exists
  const textarea = dynamicBubble.querySelector('textarea')
  if (textarea) {
    setTimeout(() => textarea.focus(), 100)
  }

  // Scroll into view
  setTimeout(() => {
    dynamicBubble.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    })
  }, 100)
}

function removeDynamicBubble(bubble) {
  bubble.style.opacity = '0'
  bubble.style.transform = 'translateY(-10px) scale(0.95)'
  setTimeout(() => {
    bubble.remove()
  }, 300)
}

function saveEdit(bubble, parentBlock) {
  const textarea = bubble.querySelector('.edit-textarea')
  const newText = textarea.value.trim()

  if (newText) {
    // Find the parent block and update its text
    const textElement = parentBlock.querySelector('.transcriptonic-text')
    if (textElement) {
      // Update the transcript array first
      const indexAttr = parentBlock.getAttribute('data-block-index')
      const index = indexAttr ? parseInt(indexAttr, 10) : -1
      if (index >= 0 && transcript[index]) {
        transcript[index].transcriptText = newText
        overWriteChromeStorageDebounced(["transcript"], false)
      }

      // Visual feedback
      parentBlock.style.background = 'rgba(76, 175, 80, 0.1)'
      setTimeout(() => {
        parentBlock.style.background = ''
      }, 1000)
    }
  }

  removeDynamicBubble(bubble)

  // Re-render the transcript display to restore floating actions
  setTimeout(() => {
    updateRealtimeTranscriptDisplay()
  }, 100)

  // Scroll to latest content after edit
  setTimeout(() => {
    const transcriptDisplayContent = document.querySelector('.transcriptonic-content')
    if (transcriptDisplayContent) {
      transcriptDisplayContent.scrollTop = transcriptDisplayContent.scrollHeight
    }
  }, 200)
}

function saveNote(bubble, parentBlock) {
  const textarea = bubble.querySelector('.note-textarea')
  const noteText = textarea.value.trim()

  console.log('saveNote called with text:', noteText)

  if (noteText) {
    // Get the block index and append note to transcript text
    const blockIndex = parseInt(parentBlock.getAttribute('data-block-index'))
    console.log('Block index for note:', blockIndex)
    
    if (transcript[blockIndex]) {
      // Append note to the original transcript text
      const originalText = transcript[blockIndex].transcriptText
      transcript[blockIndex].transcriptText = `${originalText} [Note: ${noteText}]`
      
      console.log('Updated transcript text with note:', transcript[blockIndex].transcriptText)
      
      // Save transcript with updated text
      overWriteChromeStorageDebounced(["transcript"], false)
      
      // Visual feedback
      parentBlock.style.background = 'rgba(76, 175, 80, 0.1)'
      setTimeout(() => {
        parentBlock.style.background = ''
      }, 1000)
    } else {
      console.error('Transcript entry not found at index:', blockIndex)
    }

    // Transform the dynamic bubble into a saved note
    bubble.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
        <span style="font-weight: 600; color: #2d2d2d;">📝 Note</span>
        <span style="font-size: 11px; color: #94a3b8; background: rgba(148, 163, 184, 0.1); padding: 2px 8px; border-radius: 10px;">Saved</span>
      </div>
      <div style="font-size: 13px; color: #2d2d2d; line-height: 1.4;">${noteText}</div>
    `

    // Change styling to indicate it's a saved note
    bubble.style.background = 'rgba(45, 45, 45, 0.03)'
    bubble.style.borderColor = 'rgba(45, 45, 45, 0.1)'

    // Now scroll to the latest content since note is saved
    setTimeout(() => {
      const transcriptDisplayContent = document.querySelector('.transcriptonic-content')
      if (transcriptDisplayContent) {
        transcriptDisplayContent.scrollTop = transcriptDisplayContent.scrollHeight
      }
    }, 100)
  } else {
    removeDynamicBubble(bubble)
  }
}

function saveTags(bubble, parentBlock) {
  const textarea = bubble.querySelector('.note-textarea')
  const tagsText = textarea.value.trim()

  console.log('saveTags called with text:', tagsText)

  if (tagsText) {
    // Parse tags from comma-separated text
    const tags = tagsText.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)
    
    console.log('Parsed tags:', tags)
    
    if (tags.length > 0) {
      const blockIndex = parseInt(parentBlock.getAttribute('data-block-index'))
      console.log('Block index for tags:', blockIndex)
      
      if (transcript[blockIndex]) {
        // Append tags to the original transcript text
        const originalText = transcript[blockIndex].transcriptText
        const tagString = tags.map(tag => `#${tag}`).join(' ')
        transcript[blockIndex].transcriptText = `${originalText} ${tagString}`
        
        console.log('Updated transcript text with tags:', transcript[blockIndex].transcriptText)
        
        // Save transcript with updated text
        overWriteChromeStorageDebounced(["transcript"], false)
        
        // Visual feedback
        parentBlock.style.background = 'rgba(76, 175, 80, 0.1)'
        setTimeout(() => {
          parentBlock.style.background = ''
        }, 1000)
      } else {
        console.error('Transcript entry not found at index:', blockIndex)
      }
    }
  }

  removeDynamicBubble(bubble)
  
  // Re-render the transcript display to show updated text
  setTimeout(() => {
    updateRealtimeTranscriptDisplay()
  }, 100)
}

function saveResponse(bubble, parentBlock) {
  const textarea = bubble.querySelector('.note-textarea')
  const responseText = textarea.value.trim()

  if (responseText) {
    // Add response as a new transcript block
    transcript.push({
      "personName": userName || "You",
      "timestamp": new Date().toISOString(),
      "transcriptText": responseText
    })

    removeDynamicBubble(bubble)
    updateRealtimeTranscriptDisplay()
    overWriteChromeStorageDebounced(["transcript"], false)

    console.log('Response sent:', responseText)

    // Scroll to the new response
    setTimeout(() => {
      const transcriptDisplayContent = document.querySelector('.transcriptonic-content')
      if (transcriptDisplayContent) {
        transcriptDisplayContent.scrollTop = transcriptDisplayContent.scrollHeight
      }
    }, 100)
  } else {
    removeDynamicBubble(bubble)
  }
}

// Make test function available globally for debugging
window.addTestTranscriptBlock = addTestTranscriptBlock
window.addTestUserResponse = addTestUserResponse

// Debug function to check transcript structure
// @ts-ignore - Adding debug function to window
window.debugTranscript = function() {
  console.log('=== TRANSCRIPT DEBUG ===')
  console.log('Transcript length:', transcript.length)
  console.log('Full transcript:', transcript)
  
  transcript.forEach((entry, index) => {
    console.log(`Entry ${index}:`, {
      personName: entry.personName,
      timestamp: entry.timestamp,
      transcriptText: entry.transcriptText,
      hasTags: !!entry.tags,
      hasNotes: !!entry.notes,
      tags: entry.tags || 'MISSING',
      notes: entry.notes || 'MISSING'
    })
  })
  
  console.log('TranscriptTags Map:', transcriptTags)
  console.log('=======================')
}

// Function to fix all transcript entries to have proper structure
// @ts-ignore - Adding debug function to window
window.fixTranscriptStructure = function() {
  console.log('=== FIXING TRANSCRIPT STRUCTURE ===')
  let fixed = 0
  
  transcript.forEach((entry, index) => {
    if (!entry.tags) {
      entry.tags = []
      fixed++
      console.log(`Fixed tags for entry ${index}`)
    }
    if (!entry.notes) {
      entry.notes = []
      fixed++
      console.log(`Fixed notes for entry ${index}`)
    }
  })
  
  if (fixed > 0) {
    overWriteChromeStorageDebounced(["transcript"], false)
    console.log(`Fixed ${fixed} missing properties`)
    updateRealtimeTranscriptDisplay()
  } else {
    console.log('No fixes needed - all entries have proper structure')
  }
  
  console.log('====================================')
}

// Unified action button handler
function handleActionClick(action, index) {
  const block = transcript[index]
  if (!block) return

  // Find the corresponding DOM element
  const transcriptBlocks = document.querySelectorAll('.transcriptonic-block')
  const parentBlock = transcriptBlocks[index]

  if (!parentBlock) {
    console.error('Could not find parent block for index:', index)
    return
  }

  switch (action) {
    case 'ai':
      console.log('AI action for:', block.transcriptText)
      createDynamicBubble(parentBlock, 'AI')
      break

    case 'edit':
      console.log('Edit action for:', block.transcriptText)
      createDynamicBubble(parentBlock, 'Edit')
      break

    case 'note':
      console.log('Note action for:', block.transcriptText)
      createDynamicBubble(parentBlock, 'Note')
      break

    case 'tag':
      console.log('Tag action for:', block.transcriptText)
      createDynamicBubble(parentBlock, 'Tag')
      break
  }
}

// Pushes object to array only if it doesn't already exist. chatMessage is checked for substring since some trailing text(keep Pin message) is present from a button that allows to pin the message.
/**
 * @param {ChatMessage} chatBlock
 */
function pushUniqueChatBlock(chatBlock) {
  const isExisting = chatMessages.some(item =>
    item.personName === chatBlock.personName &&
    chatBlock.chatMessageText.includes(item.chatMessageText)
  )
  if (!isExisting) {
    console.log(chatBlock)
    chatMessages.push(chatBlock)
    overWriteChromeStorageDebounced(["chatMessages"], false)
  }
}

// Saves specified variables to chrome storage. Optionally, can send message to background script to download, post saving.
/**
 * @param {Array<"transcript" | "meetingTitle" | "meetingStartTimestamp" | "chatMessages">} keys
 * @param {boolean} sendDownloadMessage
 */

// Debounced storage write to avoid quota bursts
function overWriteChromeStorageDebounced(keys, sendDownloadMessage) {
  if (Array.isArray(keys)) { keys.forEach(k => _saveKeys.add(k)) }
  _saveSendDownload = _saveSendDownload || !!sendDownloadMessage
  if (_saveRaf) return
  _saveRaf = requestAnimationFrame(() => {
    _saveRaf = null
    try {
      overWriteChromeStorage(Array.from(_saveKeys), _saveSendDownload)
    } finally {
      _saveKeys.clear(); _saveSendDownload = false
    }
  })
}
function overWriteChromeStorage(keys, sendDownloadMessage) {
  const objectToSave = {}
  // Hard coded list of keys that are accepted
  if (keys.includes("transcript")) {
    objectToSave.transcript = transcript
  }
  if (keys.includes("meetingTitle")) {
    objectToSave.meetingTitle = meetingTitle
  }
  if (keys.includes("meetingStartTimestamp")) {
    objectToSave.meetingStartTimestamp = meetingStartTimestamp
  }
  if (keys.includes("chatMessages")) {
    objectToSave.chatMessages = chatMessages
  }
  if (keys.includes("transcriptTags")) {
    objectToSave.transcriptTags = Array.from(transcriptTags.entries())
  }

  chrome.storage.local.set(objectToSave, function () {
    // Helps people know that the extension is working smoothly in the background
    pulseStatus()
    if (sendDownloadMessage) {
      /** @type {ExtensionMessage} */
      const message = {
        type: "meeting_ended"
      }
      chrome.runtime.sendMessage(message, (responseUntyped) => {
        const response = /** @type {ExtensionResponse} */ (responseUntyped)
        if (!response.success) {
          console.error(response.message)
        }
      })
    }
  })
}

function pulseStatus() {
  const statusActivityCSS = `position: fixed;
    top: 0px;
    width: 100%;
    height: 4px;
    z-index: 100;
    pointer-events: none;
    transition: background-color 0.3s ease-in
  `

  /** @type {HTMLDivElement | null}*/
  let activityStatus = document.querySelector(`#transcriptonic-status`)
  if (!activityStatus) {
    let html = document.querySelector("html")
    activityStatus = document.createElement("div")
    activityStatus.setAttribute("id", "transcriptonic-status")
    activityStatus.style.cssText = `background-color: #2A9ACA; ${statusActivityCSS}`
    html?.appendChild(activityStatus)
  }
  else {
    activityStatus.style.cssText = `background-color: #2A9ACA; ${statusActivityCSS}`
  }

  setTimeout(() => {
    activityStatus.style.cssText = `background-color: transparent; ${statusActivityCSS}`
  }, 3000)
}


// Grabs updated meeting title, if available
function updateMeetingTitle() {
  try {
    // NON CRITICAL DOM DEPENDENCY
    const meetingTitleElement = document.querySelector(".u6vdEc")
    if (meetingTitleElement?.textContent) {
      meetingTitle = meetingTitleElement.textContent
      overWriteChromeStorageDebounced(["meetingTitle"], false)
    } else {
      throw new Error("Meeting title element not found in DOM")
    }
  } catch (err) {
    console.error(err)

    if (!hasMeetingEnded) {
      logError("007", err)
    }
  }
}

// Returns all elements of the specified selector type and specified textContent. Return array contains the actual element as well as all the parents. 
/**
 * @param {string} selector
 * @param {string | RegExp} text
 */
function selectElements(selector, text) {
  var elements = document.querySelectorAll(selector)
  return Array.prototype.filter.call(elements, function (element) {
    return RegExp(text).test(element.textContent)
  })
}

// Efficiently waits until the element of the specified selector and textContent appears in the DOM. Polls only on animation frame change
/**
 * @param {string} selector
 * @param {string | RegExp} [text]
 */
async function waitForElement(selector, text, timeoutMs = 15000) {
  if (text) {
    const start = performance.now()
    while (!Array.from(document.querySelectorAll(selector)).find(element => element.textContent === text)) {
      await new Promise(requestAnimationFrame)
      if (performance.now() - start > timeoutMs) throw new Error(`waitForElement timeout: ${selector} ${text}`)
    }
  }
  else {
    const start = performance.now()
    while (!document.querySelector(selector)) {
      await new Promise(requestAnimationFrame)
      if (performance.now() - start > timeoutMs) throw new Error(`waitForElement timeout: ${selector}`)
    }
  }
  return document.querySelector(selector)
}

// Shows a responsive notification of specified type and message
/**
 * @param {ExtensionStatusJSON} extensionStatusJSON
 */
function showNotification(extensionStatusJSON) {
  // Banner CSS
  let html = document.querySelector("html")
  let obj = document.createElement("div")
  let logo = document.createElement("img")
  let text = document.createElement("p")

  logo.setAttribute(
    "src",
    "https://ejnana.github.io/transcripto-status/icon.png"
  )
  logo.setAttribute("height", "32px")
  logo.setAttribute("width", "32px")
  logo.style.cssText = "border-radius: 4px"

  // Remove banner after 5s
  setTimeout(() => {
    obj.style.display = "none"
  }, 5000)

  if (extensionStatusJSON.status === 200) {
    obj.style.cssText = `color: #2A9ACA; ${commonCSS}`
    text.innerHTML = extensionStatusJSON.message
  }
  else {
    obj.style.cssText = `color: orange; ${commonCSS}`
    text.innerHTML = extensionStatusJSON.message
  }

  obj.prepend(text)
  obj.prepend(logo)
  if (html)
    html.append(obj)
}

// CSS for notification
const commonCSS = `background: rgb(255 255 255 / 10%); 
    backdrop-filter: blur(16px); 
    position: fixed;
    top: 5%; 
    left: 0; 
    right: 0; 
    margin-left: auto; 
    margin-right: auto;
    max-width: 780px;  
    z-index: 1000; 
    padding: 0rem 1rem;
    border-radius: 8px; 
    display: flex; 
    justify-content: center; 
    align-items: center; 
    gap: 16px;  
    font-size: 1rem; 
    line-height: 1.5; 
    font-family: "Google Sans",Roboto,Arial,sans-serif; 
    box-shadow: rgba(0, 0, 0, 0.16) 0px 10px 36px 0px, rgba(0, 0, 0, 0.06) 0px 0px 0px 1px;`


// Local error logging without external transmission
function logError(code, err) {
  console.error(`Error ${code}:`, err)
}




function recoverLastMeeting() {
  return new Promise((resolve, reject) => {
    /** @type {ExtensionMessage} */
    const message = {
      type: "recover_last_meeting",
    }
    chrome.runtime.sendMessage(message, function (responseUntyped) {
      const response = /** @type {ExtensionResponse} */ (responseUntyped)
      if (response.success) {
        resolve("Last meeting recovered successfully or recovery not needed")
      }
      else {
        reject(response.message)
      }
    })
  })
}





// CURRENT GOOGLE MEET TRANSCRIPT DOM. TO BE UPDATED.

{/* <div class="a4cQT kV7vwc eO2Zfd" jscontroller="D1tHje" jsaction="bz0DVc:HWTqGc;E18dRb:lUFH9b;QBUr8:lUFH9b;stc2ve:oh3Xke" style="">
  // CAPTION LANGUAGE SETTINGS. MAY OR MAY NOT HAVE CHILDREN
  <div class="NmXUuc  P9KVBf" jscontroller="rRafu" jsaction="F41Sec:tsH52e;OmFrlf:xfAI6e(zHUIdd)"></div>
  <div class="DtJ7e">
    <span class="frX3lc-vlkzWd  P9KVBf"></span>
    <div jsname="dsyhDe" class="iOzk7 uYs2ee " style="">
      //PERSON 1
      <div class="nMcdL bj4p3b" style="">
        <div class="adE6rb M6cG9d">
          <img alt="" class="Z6byG r6DyN" src="https://lh3.googleusercontent.com/a/some-url" data-iml="63197.699999999255">
            <div class="KcIKyf jxFHg">Person 1</div>
        </div>
        <div jsname="YSxPC" class="bYevke wY1pdd" style="height: 27.5443px;">
          <div jsname="tgaKEf" class="bh44bd VbkSUe">
            Some transcript text.
            Some more text.</div>
        </div>
      </div>
      //PERSON 2
      <div class="nMcdL bj4p3b" style="">
        <div class="adE6rb M6cG9d">
          <img alt="" class="Z6byG r6DyN" src="https://lh3.googleusercontent.com/a/some-url" data-iml="63197.699999999255">
            <div class="KcIKyf jxFHg">Person 2</div>
        </div>
        <div jsname="YSxPC" class="bYevke wY1pdd" style="height: 27.5443px;">
          <div jsname="tgaKEf" class="bh44bd VbkSUe">
            Some transcript text.
            Some more text.</div>
        </div>
      </div>
    </div>
    <div jsname="APQunf" class="iOzk7 uYs2ee" style="display: none;">
    </div>
  </div>
  <div jscontroller="mdnBv" jsaction="stc2ve:MO88xb;QBUr8:KNou4c">
  </div>
</div> */}

// CURRENT GOOGLE MEET CHAT MESSAGES DOM
{/* <div jsname="xySENc" aria-live="polite" jscontroller="Mzzivb" jsaction="nulN2d:XL2g4b;vrPT5c:XL2g4b;k9UrDc:ClCcUe"
  class="Ge9Kpc z38b6">
  <div class="Ss4fHf" jsname="Ypafjf" tabindex="-1" jscontroller="LQRnv"
    jsaction="JIbuQc:sCzVOd(aUCive),T4Iwcd(g21v4c),yyLnsd(iJEnyb),yFT8A(RNMM1e),Cg1Rgf(EZbOH)" style="order: 0;">
    <div class="QTyiie">
      <div class="poVWob">You</div>
      <div jsname="biJjHb" class="MuzmKe">17:00</div>
    </div>
    <div class="beTDc">
      <div class="er6Kjc chmVPb">
        <div class="ptNLrf">
          <div jsname="dTKtvb">
          <div jscontroller="RrV5Ic" jsaction="rcuQ6b:XZyPzc" data-is-tv="false">Hello</div>
          </div>
          <div class="pZBsfc">Hover over a message to pin it<i class="google-material-icons VfPpkd-kBDsod WRc1Nb"
              aria-hidden="true">keep</i></div>
          <div class="MMfG3b"><span tooltip-id="ucc-17"></span><span data-is-tooltip-wrapper="true"><button
                class="VfPpkd-Bz112c-LgbsSe yHy1rc eT1oJ tWDL4c Brnbv pFZkBd" jscontroller="soHxf"
                jsaction="click:cOuCgd; mousedown:UX7yZ; mouseup:lbsD7e; mouseenter:tfO1Yc; mouseleave:JywGue; touchstart:p6p2H; touchmove:FwuNnf; touchend:yfqBxc; touchcancel:JMtRjd; focus:AHmuwe; blur:O22p3e; contextmenu:mg9Pef;mlnRJb:fLiPzd"
                jsname="iJEnyb" data-disable-idom="true" aria-label="Pin message" data-tooltip-enabled="true"
                data-tooltip-id="ucc-17" data-tooltip-x-position="3" data-tooltip-y-position="2" role="button"
                data-message-id="1714476309237">
                <div jsname="s3Eaab" class="VfPpkd-Bz112c-Jh9lGc"></div>
                <div class="VfPpkd-Bz112c-J1Ukfc-LhBDec"></div><i class="google-material-icons VfPpkd-kBDsod VjEpdd"
                  aria-hidden="true">keep</i>
              </button>
              <div class="EY8ABd-OWXEXe-TAWMXe" role="tooltip" aria-hidden="true" id="ucc-17">Pin message</div>
            </span></div>
        </div>
      </div>
    </div>
  </div>
</div> */}