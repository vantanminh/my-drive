# Sync lesson folders and export links

[Overview](/docs/index.md) · [Drive](/docs/drive.md) · [Uploads](/docs/uploads.md) · [Shares](/docs/shares.md)

This Python 3 example uses only the standard library. It recreates folders under a new named Drive folder, uploads each file in 8 MiB chunks, creates public file and folder links, and exports them as UTF-8 CSV for Excel / Google Sheets.

Set `MYDRIVE_ORIGIN`, `MYDRIVE_API_KEY`, `LESSON_ROOT` and `MYDRIVE_DESTINATION_NAME` in your local environment. The destination name must be new (409 protects against duplicates). Required scopes: drive:read, drive:write, shares:write. Store the CSV safely: it contains public share capabilities. No API key is written into the CSV.

The example stops on errors and saves the current upload ID in its error message so you can resume via HEAD and Upload-Offset. It does not blindly retry folder/share creation. For scheduled synchronization, persist a local manifest mapping relative paths, file fingerprints, Drive IDs, upload IDs and share URLs; skip unchanged files and resume known uploads instead of rerunning this one-time import.

```python
import csv
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

origin = os.environ["MYDRIVE_ORIGIN"].rstrip("/")
if not origin.startswith("https://"):
    raise ValueError("Use your HTTPS MyDrive origin")
key = os.environ["MYDRIVE_API_KEY"]
root = Path(os.environ["LESSON_ROOT"]).resolve(strict=True)
if not root.is_dir():
    raise ValueError("LESSON_ROOT must be a directory")


def call(method, path, payload=None, raw=None, extra=None):
    headers = {"Authorization": "Bearer " + key}
    data = raw
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    headers.update(extra or {})
    request = Request(origin + "/api/v1" + path, data=data,
                      headers=headers, method=method)
    with urlopen(request, timeout=300) as response:
        body = response.read()
        return (json.loads(body) if body else None), response.headers


def share(resource_id, kind):
    result, _ = call("POST", "/shares", {
        "resource_type": kind, "resource_id": resource_id,
        "allow_download": True
    })
    return origin + result["share_url"]


def upload(path, folder_id):
    stat = path.stat()
    session, _ = call("POST", "/uploads", {
        "filename": path.name, "expected_size": stat.st_size,
        "parent_id": folder_id
    })
    upload_id = session["id"]
    try:
        offset = session["offset"]
        with path.open("rb") as source:
            while offset < stat.st_size:
                source.seek(offset)
                chunk = source.read(min(8 * 1024 * 1024, stat.st_size - offset))
                if not chunk:
                    raise RuntimeError("Source file changed during upload")
                try:
                    _, headers = call("PATCH", "/uploads/" + upload_id,
                        raw=chunk, extra={
                            "Content-Type": "application/offset+octet-stream",
                            "Upload-Offset": str(offset)
                        })
                    offset = int(headers["Upload-Offset"])
                except HTTPError as error:
                    if error.code != 409:
                        raise
                    _, headers = call("HEAD", "/uploads/" + upload_id)
                    reconciled = int(headers["Upload-Offset"])
                    if reconciled == offset:
                        raise
                    offset = reconciled
        if path.stat().st_size != stat.st_size or path.stat().st_mtime_ns != stat.st_mtime_ns:
            raise RuntimeError("Source file changed during upload")
        result, _ = call("POST", "/uploads/" + upload_id + "/finalize")
        return result["file_id"]
    except Exception as error:
        raise RuntimeError("Upload interrupted; resume session " + upload_id) from error


def safe_cell(text):
    # Avoid spreadsheet formula interpretation of user-provided filenames.
    return "'" + text if text.startswith(("=", "+", "-", "@")) else text


folder, _ = call("POST", "/folders", {
    "name": os.environ["MYDRIVE_DESTINATION_NAME"], "parent_id": None
})
folder_ids = {root: folder["id"]}
# Save incrementally so completed links survive a later failure.
with open("lesson-links.csv", "w", newline="", encoding="utf-8-sig") as out:
    writer = csv.writer(out)
    writer.writerow(["relative_path", "kind", "mydrive_url"])
    writer.writerow([".", "folder", share(folder["id"], "folder")])
    out.flush()
    for directory, subdirs, filenames in os.walk(root, followlinks=False):
        directory = Path(directory)
        subdirs[:] = sorted(d for d in subdirs if not (directory / d).is_symlink())
        for name in subdirs:
            path = directory / name
            child, _ = call("POST", "/folders", {
                "name": name, "parent_id": folder_ids[directory]
            })
            folder_ids[path] = child["id"]
            writer.writerow([safe_cell(str(path.relative_to(root))), "folder",
                             share(child["id"], "folder")])
            out.flush()
        for name in sorted(filenames):
            path = directory / name
            if path.is_symlink() or not path.is_file():
                continue
            file_id = upload(path, folder_ids[directory])
            writer.writerow([safe_cell(str(path.relative_to(root))), "file",
                             share(file_id, "file")])
            out.flush()
print("Import lesson-links.csv into Excel or Google Sheets")
```

Share the spreadsheet with your friends. Clicking the folder, video or PDF URL opens MyDrive's public viewer. If you later revoke the API key and keep links, these URLs continue working. To stop access, revoke the corresponding share in Shared links or choose **Revoke its links** in Developer settings.
