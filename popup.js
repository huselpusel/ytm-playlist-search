'use strict';

// Load saved setting and apply to UI
chrome.storage.sync.get(['clickAction'], ({ clickAction }) => {
  const value = clickAction || 'scroll';
  applySelection(value);
});

// Handle radio changes
document.querySelectorAll('input[name="action"]').forEach(radio => {
  radio.addEventListener('change', () => {
    const value = radio.value;

    // Save to storage
    chrome.storage.sync.set({ clickAction: value });

    // Update visual state
    applySelection(value);

    // Notify the active YTM tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'updateSetting', value }).catch(() => {
          // Tab might not have the content script (e.g. not on YTM) — ignore
        });
      }
    });
  });
});

function applySelection(value) {
  // Check the right radio
  const radio = document.querySelector(`input[value="${value}"]`);
  if (radio) radio.checked = true;

  // Highlight the selected option card
  document.querySelectorAll('.option').forEach(opt => {
    const optValue = opt.querySelector('input').value;
    opt.classList.toggle('selected', optValue === value);
  });
}
