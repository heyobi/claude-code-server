"""Web Push, so an answer reaches the phone with the app closed.

This is the one part of the project that needs something outside the standard
library: RFC 8291 wants ECDH on P-256 and RFC 8292 wants an ES256 signature, and
neither is in the box. `cryptography` is imported lazily so everything else
still runs on a machine that does not have it — push simply reports itself as
unavailable.

Two specs are involved and it is worth naming them, because the failure mode of
getting either subtly wrong is a push service answering 400 with no explanation:

  RFC 8291  the payload, encrypted to a key the browser generated
  RFC 8292  the VAPID header, which is how the push service knows it is us
"""

import base64
import json
import os
import struct
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~")
KEYFILE = os.path.join(HOME, ".config", "claude-code-server", "vapid.json")
SUBSFILE = os.path.join(HOME, ".claude", "claude-code-server", "push-subs.json")
CONTACT = "mailto:admin@localhost"
TTL = 86400
RECORD_SIZE = 4096


def available():
    try:
        import cryptography  # noqa: F401
        return True
    except ImportError:
        return False


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def unb64(text):
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


# --------------------------------------------------------------------------- keys


def keys():
    """The application server keypair, made once and kept.

    Its public half is baked into every subscription the browser creates, so
    replacing the file invalidates every subscription that already exists.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    try:
        with open(KEYFILE, encoding="utf-8") as handle:
            saved = json.load(handle)
        private = serialization.load_pem_private_key(
            saved["private_pem"].encode(), password=None)
        return private, saved["public"]
    except (OSError, ValueError, KeyError):
        pass

    private = ec.generate_private_key(ec.SECP256R1())
    public = private.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint)
    saved = {
        "private_pem": private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption()).decode(),
        "public": b64(public),
    }
    os.makedirs(os.path.dirname(KEYFILE), exist_ok=True)
    with open(KEYFILE, "w", encoding="utf-8") as handle:
        json.dump(saved, handle, indent=2)
    os.chmod(KEYFILE, 0o600)
    return private, saved["public"]


def public_key():
    return keys()[1]


# --------------------------------------------------------------------------- subs


def load_subs():
    try:
        with open(SUBSFILE, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return {}


def save_subs(subs):
    os.makedirs(os.path.dirname(SUBSFILE), exist_ok=True)
    tmp = SUBSFILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(subs, handle, indent=2)
    os.replace(tmp, SUBSFILE)
    os.chmod(SUBSFILE, 0o600)


def subscribe(subscription):
    subs = load_subs()
    subs[subscription["endpoint"]] = subscription
    save_subs(subs)
    return len(subs)


def unsubscribe(endpoint):
    subs = load_subs()
    subs.pop(endpoint, None)
    save_subs(subs)
    return len(subs)


# --------------------------------------------------------------------------- vapid


def vapid_header(endpoint):
    from urllib.parse import urlsplit
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec, utils

    private, public = keys()
    parts = urlsplit(endpoint)
    claims = {
        "aud": "{}://{}".format(parts.scheme, parts.netloc),
        "exp": int(time.time()) + 12 * 3600,
        "sub": CONTACT,
    }
    header = b64(json.dumps({"typ": "JWT", "alg": "ES256"},
                            separators=(",", ":")).encode())
    body = b64(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = "{}.{}".format(header, body).encode()

    der = private.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der)
    # JOSE wants the raw pair, fixed width. DER is what the library hands back.
    raw = r.to_bytes(32, "big") + s.to_bytes(32, "big")
    token = "{}.{}.{}".format(header, body, b64(raw))
    return "vapid t={}, k={}".format(token, public)


# --------------------------------------------------------------------------- body


def encrypt(plaintext, client_public_b64, auth_b64):
    """RFC 8291 aes128gcm, single record."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.hashes import SHA256
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    client_public_raw = unb64(client_public_b64)
    auth = unb64(auth_b64)
    client_public = ec.EllipticCurvePublicKey.from_encoded_point(
        ec.SECP256R1(), client_public_raw)

    ephemeral = ec.generate_private_key(ec.SECP256R1())
    ephemeral_public_raw = ephemeral.public_key().public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint)
    shared = ephemeral.exchange(ec.ECDH(), client_public)

    # The order of the two public keys in this info string is the part everyone
    # gets wrong: receiver first, then sender.
    prk = HKDF(algorithm=SHA256(), length=32, salt=auth,
               info=b"WebPush: info\x00" + client_public_raw + ephemeral_public_raw
               ).derive(shared)

    salt = os.urandom(16)
    content_key = HKDF(algorithm=SHA256(), length=16, salt=salt,
                       info=b"Content-Encoding: aes128gcm\x00").derive(prk)
    nonce = HKDF(algorithm=SHA256(), length=12, salt=salt,
                 info=b"Content-Encoding: nonce\x00").derive(prk)

    padded = plaintext + b"\x02"          # last-record delimiter
    sealed = AESGCM(content_key).encrypt(nonce, padded, None)
    return (salt
            + struct.pack(">I", RECORD_SIZE)
            + struct.pack("B", len(ephemeral_public_raw))
            + ephemeral_public_raw
            + sealed)


# --------------------------------------------------------------------------- send


def send_one(subscription, payload, urgency="normal"):
    endpoint = subscription["endpoint"]
    body = encrypt(json.dumps(payload).encode("utf-8"),
                   subscription["keys"]["p256dh"],
                   subscription["keys"]["auth"])
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(TTL),
        "Urgency": urgency,
        "Authorization": vapid_header(endpoint),
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, ""
    except urllib.error.HTTPError as exc:
        return exc.code, (exc.read() or b"")[:200].decode("utf-8", "ignore")
    except Exception as exc:
        return 0, str(exc)[:200]


def send_all(payload, urgency="normal"):
    """Push to every subscription, dropping the ones the service has retired."""
    subs = load_subs()
    results = []
    dead = []
    for endpoint, subscription in list(subs.items()):
        status, detail = send_one(subscription, payload, urgency)
        results.append((endpoint[:48], status, detail))
        if status in (404, 410):
            dead.append(endpoint)
    if dead:
        for endpoint in dead:
            subs.pop(endpoint, None)
        save_subs(subs)
    return results
