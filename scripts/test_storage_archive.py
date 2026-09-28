import io
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

import storage_archive


class SecretsArchiveTests(unittest.TestCase):
    def archive(self, include_key):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for root in ["objects", "uploads", "trash"] + ([".secrets"] if include_key else []):
                member = tarfile.TarInfo(root)
                member.type = tarfile.DIRTYPE
                archive.addfile(member)
            if include_key:
                member = tarfile.TarInfo(".secrets/google-drive-token.key")
                member.size = 32
                archive.addfile(member, io.BytesIO(bytes(range(32))))
        return output.getvalue()

    def test_restore_keeps_key_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "restored"
            result = subprocess.run([sys.executable, str(Path(storage_archive.__file__)),
                "extract", str(target), "--roots", "objects", "uploads", "trash", ".secrets"],
                input=self.archive(True), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            key = target / ".secrets/google-drive-token.key"
            self.assertEqual(key.read_bytes(), bytes(range(32)))
            if os.name == "posix":
                self.assertEqual(key.stat().st_mode & 0o777, 0o600)
                self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)

    def test_legacy_backup_without_key_still_restores(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "restored"
            result = subprocess.run([sys.executable, str(Path(storage_archive.__file__)),
                "extract", str(target), "--roots", "objects", "uploads", "trash", ".secrets"],
                input=self.archive(False), capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            self.assertTrue((target / ".secrets").is_dir())
            self.assertFalse((target / ".secrets/google-drive-token.key").exists())

    def test_missing_required_data_root_is_rejected(self):
        result = subprocess.run([sys.executable, str(Path(storage_archive.__file__)),
            "validate", "--roots", "objects", "uploads", "trash", "previews", ".secrets"],
            input=self.archive(False), capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"missing required storage roots: previews", result.stderr)

    def test_secret_path_traversal_is_rejected(self):
        member = tarfile.TarInfo(".secrets/../escaped.key")
        with self.assertRaises(storage_archive.ArchiveError):
            storage_archive.member_path(member)


if __name__ == "__main__":
    unittest.main()
