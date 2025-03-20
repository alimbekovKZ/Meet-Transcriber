// Options page controller

// Form elements
const optionsForm = document.getElementById('optionsForm');
const apiKeyInput = document.getElementById('apiKey');
const autoTranscriptionCheckbox = document.getElementById('autoTranscription');
const enableNotificationsCheckbox = document.getElementById('enableNotifications');
const defaultLanguageSelect = document.getElementById('defaultLanguage');
const filenameTemplateInput = document.getElementById('filenameTemplate');
const alertMessage = document.getElementById('alertMessage');
const apiUrlInput = document.getElementById('apiUrl');
const authMethodSelect = document.getElementById('authMethod');
const serviceOpenAI = document.getElementById('serviceOpenAI');
const serviceCustom = document.getElementById('serviceCustom');

// Default OpenAI endpoint
const OPENAI_API_URL = "https://api.openai.com/v1/audio/transcriptions";

// Load saved settings
document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get([
        'apiKey',
        'autoTranscription',
        'enableNotifications',
        'defaultLanguage',
        'filenameTemplate',
        'apiUrl',
        'authMethod',
        'apiService'
    ], (result) => {
        // Populate form with saved settings
        if (result.apiKey) {
            apiKeyInput.value = result.apiKey;
        }
        
        if (result.apiUrl) {
            apiUrlInput.value = result.apiUrl;
        } else {
            apiUrlInput.value = OPENAI_API_URL;
        }
        
        if (result.authMethod) {
            authMethodSelect.value = result.authMethod;
        }
        
        if (result.apiService) {
            if (result.apiService === 'openai') {
                serviceOpenAI.checked = true;
            } else {
                serviceCustom.checked = true;
            }
        }
        
        if (result.hasOwnProperty('autoTranscription')) {
            autoTranscriptionCheckbox.checked = result.autoTranscription;
        } else {
            autoTranscriptionCheckbox.checked = true; // Default to true
        }
        
        if (result.hasOwnProperty('enableNotifications')) {
            enableNotificationsCheckbox.checked = result.enableNotifications;
        } else {
            enableNotificationsCheckbox.checked = true; // Default to true
        }
        
        if (result.defaultLanguage) {
            defaultLanguageSelect.value = result.defaultLanguage;
        }
        
        if (result.filenameTemplate) {
            filenameTemplateInput.value = result.filenameTemplate;
        }
        
        // Update UI based on service selection
        updateServiceUI();
    });
    
    // Setup event listeners
    serviceOpenAI.addEventListener('change', updateServiceUI);
    serviceCustom.addEventListener('change', updateServiceUI);
});

// Update UI based on service selection
function updateServiceUI() {
    const isCustomService = serviceCustom.checked;
    
    if (isCustomService) {
        // Show custom service options
        document.getElementById('apiUrlGroup').style.display = 'block';
        document.getElementById('authMethodGroup').style.display = 'block';
        apiUrlInput.required = true;
        
        // Assuming key is a project key
        if (apiKeyInput.value.includes('proj')) {
            authMethodSelect.value = 'apikey'; // Suggest API Key header for project keys
        }
    } else {
        // Standard OpenAI settings
        document.getElementById('apiUrlGroup').style.display = 'none';
        document.getElementById('authMethodGroup').style.display = 'none';
        apiUrlInput.required = false;
        apiUrlInput.value = OPENAI_API_URL;
        authMethodSelect.value = 'bearer';
    }
}

// Save settings
optionsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    // Validate API key - basic check to ensure it's not empty
    const apiKey = apiKeyInput.value.trim();
    if (!apiKey) {
        showAlert('Пожалуйста, введите API ключ', 'error');
        return;
    }
    
    // Get custom API URL if provided
    const apiUrl = apiUrlInput.value.trim() || OPENAI_API_URL;
    
    // Get authentication method
    const authMethod = authMethodSelect.value;
    
    // Get selected service
    const apiService = serviceOpenAI.checked ? 'openai' : 'custom';
    
    // Save settings to storage
    chrome.storage.local.set({
        apiKey: apiKey,
        apiUrl: apiUrl,
        authMethod: authMethod,
        apiService: apiService,
        autoTranscription: autoTranscriptionCheckbox.checked,
        enableNotifications: enableNotificationsCheckbox.checked,
        defaultLanguage: defaultLanguageSelect.value,
        filenameTemplate: filenameTemplateInput.value
    }, () => {
        // Show success message
        showAlert('Настройки успешно сохранены!', 'success');
    });
});

// Show alert message
function showAlert(message, type) {
    alertMessage.textContent = message;
    alertMessage.className = 'alert ' + type;
    alertMessage.style.display = 'block';
    
    // Hide message after 3 seconds
    setTimeout(() => {
        alertMessage.style.display = 'none';
    }, 3000);
}