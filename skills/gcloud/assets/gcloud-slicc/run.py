#!/usr/bin/python3
"""Run gcloud or bq with a credential sealed in the SLICC vault as GCLOUD_CREDENTIALS.

The sealed value is the credential JSON (a service-account key or an
authorized_user credential), base64-encoded: a raw JSON value would break the
vault's scrubbing of model requests. The vault hands the real value only to
this program. The decoded JSON lives in a 0600 temporary file for the length
of the run, named by CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE and
GOOGLE_APPLICATION_CREDENTIALS, and is deleted when gcloud or bq exits.
"""
import atexit, base64, binascii, json, os, runpy, sys, tempfile

BIN = "/usr/local/lib/gcloud-cli/bin"
if len(sys.argv) < 2 or sys.argv[1] not in ("gcloud", "bq"):
    sys.exit("usage: run.py gcloud|bq [ARGS...]")
tool = sys.argv[1]
cred = os.environ.pop("GCLOUD_CREDENTIALS", "").strip()
if cred.startswith("fnox_proxy_"):
    sys.exit("run.py: GCLOUD_CREDENTIALS is still a placeholder; the vault did not grant it to this program")
if cred:
    try:
        data = base64.b64decode(cred, validate=True)
        json.loads(data)
    except (binascii.Error, ValueError):
        sys.exit("run.py: GCLOUD_CREDENTIALS is not base64-encoded credential JSON")
    fd, path = tempfile.mkstemp(prefix="gcloud-cred-", suffix=".json")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    data = None
    atexit.register(lambda: os.path.exists(path) and os.unlink(path))
    os.environ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = path
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path
cred = None
script = os.path.join(BIN, tool)
sys.argv = [script] + sys.argv[2:]
runpy.run_path(script, run_name="__main__")
