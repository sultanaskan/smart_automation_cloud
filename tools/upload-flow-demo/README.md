# Sequential server-check upload demo

This isolated local page reproduces the file-upload behavior needed for workflow testing:

1. It exposes one hidden `<input type="file">` at a time, immediately after a clickable upload `<div>`.
2. Selecting a file sends one multipart HTTP request to the local Node server.
3. The server waits for its scan delay, validates the PDF extension and `%PDF-` signature, then responds.
4. Only a successful server response reveals the next file input. The flow stops after four accepted files.

The upload markup mirrors the saved IVAC page's relevant DOM shape and uses the same locator:

```css
div.w-full.cursor-pointer + input[type="file"][accept=".pdf,application/pdf"]
```

Files remain in memory and are never written to disk. The default simulated scan delay is 2.5 seconds and each file is limited to 500 KB, matching the saved page's displayed limit.

From `cloud-server-node`, run:

```powershell
npm run upload-flow-demo
```

Then open <http://127.0.0.1:4175/>. To change the simulated scan delay, set `UPLOAD_DEMO_SCAN_DELAY_MS` before starting the server. This demo is separate from the production web application server and binds only to localhost.
