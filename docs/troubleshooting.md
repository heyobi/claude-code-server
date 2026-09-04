# Troubleshooting

Notes from building this on an Ubuntu 24.04 box. Some of it is about
claude-code-server, some is about the kind of hardware people press into service
as a home server.

## Sessions

### A session vanished

You typed `exit` inside `tmux`. That closes the window, and closing the last
window ends the session and stops the tmux server with it. Detach with
`Ctrl+B` then `D`. Closing the terminal window itself is safe.

If it happens at boot instead, check lingering:

```bash
loginctl show-user "$USER" -p Linger
sudo loginctl enable-linger "$USER"
```

Without it, systemd may stop your user's processes when the last login ends.

### A session is stuck on the trust prompt

`CCS_WORKDIR` points at `$HOME`. Claude Code does not persist the trust flag for
a home directory, so every session asks again and an unattended one waits
forever. Point `CCS_WORKDIR` at a subdirectory, answer the prompt once by hand,
and confirm it stuck:

```bash
python3 - <<'PY'
import json, os
config = json.load(open(os.path.expanduser("~/.claude.json")))
for path, entry in config.get("projects", {}).items():
    if isinstance(entry, dict):
        print(path, entry.get("hasTrustDialogAccepted"))
PY
```

### ccs-list says "starting" and never changes

The transcript for that session cannot be found. Either it really is still
booting, or it was started outside this tool and the fallback lookup failed.
Check that the uuid file matches a real transcript:

```bash
cat ~/.claude/claude-code-server/sessions/<session>.uuid
ls ~/.claude/projects/*/
```

### Sessions are not being renamed

Look at the log:

```bash
tail ~/.claude/claude-code-server/pool.log
```

`busy, deferring rename` means the safety check is doing its job: Claude was
generating, or there was unsent text in the prompt. It retries on the next tick.
Set `CCS_AUTO_RENAME=0` to turn renaming off entirely.

## Hardware notes

### A USB disk that resets under load

Symptoms: `reset SuperSpeed USB device` in `dmesg` every few seconds, transfer
rates bouncing between 15 and 90 MB/s, sometimes a full `USB disconnect` that
takes the mount with it.

Two separate causes, both worth checking.

**The UAS driver.** Several JMicron bridge chips are unstable with `uas`. Check
which driver claimed the device:

```bash
lsusb -t
ls /sys/bus/usb/drivers/uas/
```

Force the older, slower, far more reliable `usb-storage` driver for that device
only. Find the id with `lsusb`, then:

```bash
echo 'options usb-storage quirks=152d:0583:u' | sudo tee /etc/modprobe.d/usb-storage-quirks.conf
sudo update-initramfs -u
```

`u` means IGNORE_UAS. Reboot, or unbind and rebind the device to apply it now.

**Power.** A 3.5" drive pulls more current than one USB port provides, and
enclosures ship with a Y cable whose second connector is easy to leave unplugged.
Plugging it in took one setup here from an average of 37 MB/s with 76 resets to
177 MB/s with 5 — a 4.8x difference from a cable that was dangling behind the
desk. Check that before you blame the driver.

Note which layer the errors come from. `hdparm -t --direct /dev/sdX` bypasses the
filesystem; if the resets persist there, the filesystem is not your problem and
reformatting will not help.

### Is the disk actually failing?

Usually not. Check before assuming:

```bash
sudo smartctl -H -A -d sat /dev/sdX
```

`Reallocated_Sector_Ct`, `Current_Pending_Sector` and `Offline_Uncorrectable` at
zero means the platters are fine. `UDMA_CRC_Error_Count` at zero means the SATA
link inside the enclosure is clean too, which points the finger at the USB side.

### A BitLocker volume Linux refuses to mount

If `cryptsetup` says `BITLK devices with type 'encrypt-on-write' cannot be
activated` and `dislocker` complains about `EOW_INFORMATION_OFFSET_GUID`, the
volume is mid-conversion: part of it is encrypted and part is not, and neither
tool can read that state. It is not a password problem.

Plug the disk into Windows and let BitLocker finish:

```
manage-bde -status D:
manage-bde -off D:
```

Wait for `Fully Decrypted` and `Percentage Encrypted: 0.0%`. Do not judge
progress by anything else — reading the volume's boot sector from Windows is
misleading, because `\\.\D:` sits above the BitLocker filter driver and always
shows you decrypted content. Only `manage-bde` tells you the truth.

### NTFS on Linux

The in-kernel `ntfs3` driver is considerably faster than FUSE-based `ntfs-3g`
for large sequential reads. Load it at boot and mount by UUID with `nofail` so a
missing USB disk never blocks startup:

```
# /etc/modules-load.d/ntfs3.conf
ntfs3
```

```
# /etc/fstab
UUID=XXXXXXXXXXXXXXXX  /mnt/data  ntfs3  defaults,nofail,uid=1000,gid=1000,umask=022,windows_names,x-systemd.device-timeout=15  0  0
```

`findmnt --verify` warns `ntfs3 does not match with on-disk ntfs`. That is
cosmetic; it compares the driver name against the blkid type string.
