'use strict';

const maxApplicants = 4;
const uploadList = document.querySelector('#upload-list');
const applicantCount = document.querySelector('#applicant-count');
const serverStatus = document.querySelector('#server-status');
const confirmButton = document.querySelector('#confirm');
let sessionId;
let acceptedCount = 0;

function startNewApplication() {
  sessionId = crypto.randomUUID();
  acceptedCount = 0;
  uploadList.replaceChildren();
  addApplicantUpload(1);
  updateCount();
  setStatus("Waiting for the primary applicant's file.");
  confirmButton.disabled = true;
}

function updateCount() {
  applicantCount.textContent = `Total number of applicants: ${acceptedCount}`;
}

function setStatus(message, state = '') {
  serverStatus.textContent = message;
  serverStatus.className = `server-status ${state}`;
}

function addApplicantUpload(slot) {
  const applicantLabel = slot === 1
    ? "Upload Primary Applicant's Webfile *"
    : `Upload Applicant ${slot}'s Webfile *`;
  const host = document.createElement('div');
  host.className = 'w-full applicant-upload';
  host.dataset.applicant = String(slot);
  host.innerHTML = `
    <div class="w-full h-12 sm:h-14 rounded-2xl sm:rounded-3xl border-2 sm:border-[3px] border-dashed transition-all flex items-center justify-center gap-1 sm:gap-2 px-3 sm:px-4 border-[#2A2E712B] hover:border-secondary/50 hover:bg-[#FEF8EE]/30 cursor-pointer upload-drop-area" role="button" tabindex="0" aria-label="${applicantLabel}">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 14v5h14v-5"/></svg>
      <label class="text-sm sm:text-lg md:text-xl font-normal leading-[100%] text-center cursor-pointer text-black" for="upload-file-${slot}">${applicantLabel}</label>
    </div>
    <input id="upload-file-${slot}" name="webfile_${slot}" type="file" accept=".pdf,application/pdf" class="hidden sf-hidden" data-upload-slot="${slot}">
    <div class="mt-3 sm:mt-4 bg-[#FEF8EE] border border-[#FF671F]/20 rounded-xl p-3 sm:p-4 upload-help">
      <p>Upload your ${slot === 1 ? 'primary' : `applicant ${slot}`} web file that matches the sign-up information.</p>
      <p>Once selected, it cannot be deleted or reuploaded. Maximum file size: <strong>500KB</strong>. Only PDF files are accepted.</p>
      <div class="upload-result" id="result-${slot}" aria-live="polite">Waiting for a file</div>
    </div>`;
  uploadList.append(host);

  const input = host.querySelector('input[type="file"]');
  const dropArea = host.querySelector('.upload-drop-area');
  dropArea.addEventListener('click', () => input.click());
  dropArea.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => uploadOne(input, slot));
}

async function uploadOne(input, slot) {
  const file = input.files?.[0];
  if (!file) return;
  const resultLabel = document.querySelector(`#result-${slot}`);
  const host = input.closest('.applicant-upload');
  input.disabled = true;
  host.classList.add('is-scanning');
  resultLabel.textContent = 'Uploading… server check in progress.';
  setStatus(`Checking applicant ${slot}'s PDF on the server…`, 'checking');

  const form = new FormData();
  form.append('sessionId', sessionId);
  form.append('slot', String(slot));
  form.append('file', file);

  try {
    const response = await fetch('/api/upload', { method: 'POST', body: form });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Server returned ${response.status}.`);

    acceptedCount = body.slot;
    host.classList.remove('is-scanning');
    host.classList.add('is-accepted');
    resultLabel.textContent = `${body.filename} — ${formatBytes(body.bytes)} — server check passed`;
    // Keep the saved-file result visible, but remove the consumed file input so
    // the page-wide IVAC-style selector resolves the next applicant input.
    input.remove();
    updateCount();
    if (body.nextSlot) {
      addApplicantUpload(body.nextSlot);
      setStatus(`Applicant ${slot}'s file passed server check. The next upload field is ready.`, 'success');
    } else {
      confirmButton.disabled = false;
      setStatus('All four applicant files passed server check.', 'success');
    }
  } catch (error) {
    host.classList.remove('is-scanning');
    host.classList.add('is-rejected');
    input.value = '';
    input.disabled = false;
    resultLabel.textContent = error.message;
    setStatus(`Applicant ${slot}'s file was not accepted. Choose a corrected PDF.`, 'error');
  }
}

function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

confirmButton.addEventListener('click', () => {
  if (!confirmButton.disabled) setStatus('All applicant documents are ready for confirmation.', 'success');
});

startNewApplication();
