#!/usr/bin/python3 -I
"""Run gcloud or bq with a credential sealed in the SLICC vault as GCLOUD_CREDENTIALS.

The sealed value is the credential JSON (a service-account key or an
authorized_user credential), base64-encoded: a raw JSON value would break the
vault's scrubbing of model requests. The vault hands the real value only to
this program. The decoded JSON lives in a 0600 file in a private 0700
directory, named by CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE and
GOOGLE_APPLICATION_CREDENTIALS, for the length of the run. It is removed when
gcloud or bq exits, raises, or the runner gets SIGTERM, SIGHUP or SIGINT.
SIGKILL cannot be caught: a file left by one sits in a 0700 directory and is
removed by the next run. BIN is fixed on purpose: fnox exec passes the
caller's environment through, so it must not choose what runs with the key.
"""
import atexit, base64, binascii, json, os, runpy, shutil, signal, sys, tempfile

BIN = "/usr/local/lib/gcloud-cli/bin"


def fail(msg):
    sys.stderr.write("run.py: " + msg + "\n")
    sys.exit(2)


def alive(pid):
    if os.path.isdir("/proc/self"):
        return os.path.exists("/proc/%d" % pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def remove_stale():
    root = tempfile.gettempdir()
    for name in os.listdir(root):
        parts = name.split("-")
        full = os.path.join(root, name)
        if len(parts) < 4 or parts[:2] != ["gcloud", "cred"] or not parts[2].isdigit():
            continue
        if os.path.isdir(full) and os.stat(full).st_uid == os.getuid() and not alive(int(parts[2])):
            shutil.rmtree(full, ignore_errors=True)


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("gcloud", "bq"):
        fail("usage: run.py gcloud|bq [ARGS...]")
    tool = sys.argv[1]
    cred = os.environ.pop("GCLOUD_CREDENTIALS", "").strip()
    if cred.startswith("fnox_proxy_"):
        fail("GCLOUD_CREDENTIALS is still a placeholder; the vault did not grant it to this program")
    remove_stale()
    if cred:
        try:
            data = base64.b64decode(cred, validate=True)
            json.loads(data)
        except (binascii.Error, ValueError):
            fail("GCLOUD_CREDENTIALS is not base64-encoded credential JSON")
        cred = None
        tmp = tempfile.mkdtemp(prefix="gcloud-cred-%d-" % os.getpid())
        removed = []

        def cleanup():
            if not removed:
                removed.append(True)
                shutil.rmtree(tmp, ignore_errors=True)

        def on_signal(signum, _frame):
            cleanup()
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

        atexit.register(cleanup)
        for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
            signal.signal(sig, on_signal)
        path = os.path.join(tmp, "credentials.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        data = None
        os.environ["CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"] = path
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path
    script = os.path.join(BIN, tool)
    sys.argv = [script] + sys.argv[2:]
    runpy.run_path(script, run_name="__main__")


if __name__ == "__main__":
    main()
