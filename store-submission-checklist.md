# Chrome Web Store Submission Checklist

## Required Assets

### Icons and Branding
- [X] Icon files in multiple sizes (16x16, 32x32, 48x48, 128x128)
- [ ] Promo images:
  - [ ] Small promo tile (440x280px)
  - [ ] Large promo tile (920x680px)
  - [ ] Marquee promo tile (1400x560px)

### Screenshots
- [ ] At least 1-3 high-quality screenshots (1280x800px or 640x400px)
- [ ] Screenshots should showcase:
  - [ ] Main popup interface
  - [ ] Recording in progress
  - [ ] Transcription result
  - [ ] Options/settings page

### Store Listing Content
- [ ] Detailed extension description (up to 132 characters)
- [ ] Full description (up to 16,000 characters)
- [ ] Privacy policy URL
- [ ] Website URL (optional)
- [ ] Support email

## Technical Requirements

### Code & Packaging
- [ ] All code is properly minified for production
- [ ] Remove any console.log statements not needed for operation
- [ ] Check for hardcoded API keys or secrets (remove if any)
- [ ] Ensure manifest.json is valid and up to date
- [ ] Package all required files in a ZIP archive

### Permissions
- [ ] Verify all permissions are necessary and justified
- [ ] Be prepared to explain why each permission is required:
  - `activeTab`: Required to interact with Google Meet pages
  - `storage`: Required to store API keys and transcription data
  - `tabs`: Required to detect Google Meet tabs and inject content scripts
  - `notifications`: Required to alert users about recording status
  - `downloads`: Required to save transcription files

### Privacy
- [ ] Create a comprehensive privacy policy explaining:
  - [ ] What data is collected
  - [ ] How audio data is processed
  - [ ] How transcription data is stored and handled
  - [ ] Third-party services used (OpenAI Whisper API)
  - [ ] User rights regarding their data

## Testing Before Submission

### Functionality Testing
- [ ] Test all features end-to-end:
  - [ ] Audio capture from Google Meet
  - [ ] Transcription process
  - [ ] File saving and downloading
  - [ ] UI interactions and feedback
- [ ] Test with different meeting lengths:
  - [ ] Short meetings (< 5 minutes)
  - [ ] Medium meetings (15-30 minutes)
  - [ ] Long meetings (1+ hour)
- [ ] Test on different Chrome versions
- [ ] Test with different audio sources

### Edge Cases
- [ ] Test with no internet connection
- [ ] Test recovery after connection loss
- [ ] Test with invalid API key
- [ ] Test with permission denial
- [ ] Test when tabs are closed during recording

## Final Review
- [ ] Perform a security review to ensure no vulnerabilities
- [ ] Check that the extension adheres to [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/)
- [ ] Verify all user-facing text is correct and free of typos
- [ ] Ensure extension fully supports all supported languages
- [ ] Check for any accessibility issues

## Submission Process
1. Go to the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. Sign in with your Google account
3. Pay the one-time developer fee ($5.00 USD) if you haven't already
4. Click "Add new item" and upload your ZIP file
5. Fill in all required fields with your prepared content
6. Submit for review

## Post-Submission
- [ ] Prepare for potential review questions
- [ ] Create a system for monitoring user feedback
- [ ] Plan for future updates and feature improvements

## Common Reasons for Rejection
- Insufficient information in the store listing
- Missing or inadequate privacy policy
- Requesting unnecessary permissions
- Security vulnerabilities
- Misleading description or functionality
- Low-quality images or screenshots
- Violation of Chrome Web Store policies

Be sure to address all these points thoroughly to improve chances of approval on the first submission.