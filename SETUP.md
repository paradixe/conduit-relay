# راه‌اندازی ریلی کاندویت

یه سرور میخری، یه دستور میزنی، تمام. مردم ایران ازش استفاده میکنن فیلترشکن داشته باشن.

---

## ۱. سرور بخر

برو [LowEndBox](https://lowendbox.com) یا [LowEndTalk](https://lowendtalk.com) یه VPS بگیر.

**حداقل:**
- 1GB RAM
- 1 CPU
- اوبونتو 22.04
- ماهی 3-10 ترابایت ترافیک
- Ubuntu 22/24 پیشناهاد

**نکته:** سرورای ارزون معمولاً ماهی $3-51 هستن. GeorgeDataCenter , RackNerd و خوبن.

بعد خرید یه ایمیل میاد با:
- IP سرور (مثلاً `123.45.67.89`)
- پسورد root

---

## ۲. وصل شو به سرور

**مک/لینوکس:**
```bash
ssh root@123.45.67.89
```

اولین بار یه سوال میپرسه:
```
Are you sure you want to continue connecting (yes/no)?
```
بزن `yes` اینتر.

بعد پسورد رو بزن (تایپ میکنی ولی چیزی نشون نمیده، نترس).

**ویندوز:**
[PuTTY](https://putty.org) رو دانلود کن، IP رو بزن، وصل شو. همون سوال fingerprint رو میپرسه، Yes بزن.


---

## ۳. نصب ریلی

این رو کپی پیست کن:
```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | bash
```

تمام. ریلی داره کار میکنه.

**تنظیمات:**
- `-m` تعداد کلاینت (پیش‌فرض: 200)
- `-b` محدودیت سرعت به Mbps (پیش‌فرض: -1 = نامحدود)

مثلاً با 500 کلاینت و 100 مگابیت:
```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | MAX_CLIENTS=500 BANDWIDTH=100 bash
```

چک کن درست کار میکنه:
```bash
journalctl -u conduit -f
```
باید یه چیزی مثل این ببینی:
```
[STATS] Connected: 45 | Up: 2.3 GB | Down: 18.7 GB
```

---

## ۴. داشبورد (اختیاری)

میخوای یه صفحه وب داشته باشی که وضعیت سرورت رو ببینی؟

```bash
# اول Node.js نصب کن
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# داشبورد رو بگیر
cd /opt
git clone https://github.com/paradixe/conduit-relay.git conduit-dashboard
cd conduit-dashboard/dashboard

# تنظیمات
cp .env.example .env
nano .env
```

تو فایل `.env`:
```
DASHBOARD_PASSWORD=یه‌پسورد‌قوی
```

سرورها رو تو `servers.json` بذار:
```json
[
  { "name": "server1", "host": "123.45.67.89", "user": "root" }
]
```

```bash
npm install
npm start
```

برو `http://123.45.67.89:3000` ببین.

---

## ۵. چند سرور داری؟

اگه بیشتر از یه سرور داری، از لپتاپت مدیریتشون کن.

### SSH Key بساز (یه بار از لپتاپت)
```bash
mkdir -p ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
```
این یه کلید میسازه بدون پسورد.

### کلید رو ببین
```bash
cat ~/.ssh/id_ed25519.pub
```
این رو کپی کن.

### کلید رو به سرور بده
SSH بزن به سرور، بعد:
```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "اینجا کلید رو پیست کن" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

یا اگه `ssh-copy-id` داری (راحت‌تره):
```bash
ssh-copy-id root@123.45.67.89
```

### fleet.sh استفاده کن
```bash
./fleet.sh add server1 123.45.67.89
./fleet.sh add server2 111.22.33.44
./fleet.sh status
./fleet.sh update all
```

---

## کمک

مشکلی داری؟ ایشو بزن: https://github.com/paradixe/conduit-relay/issues

---

# English

## 1. Buy a VPS

Hit up [LowEndBox](https://lowendbox.com). Get something with:
- 1GB RAM
- Ubuntu 22.04
- 3TB+ monthly transfer

$3-5/month. RackNerd and BuyVM are solid.

You'll get an email with your server IP and root password.

## 2. Connect

```bash
ssh root@YOUR_IP
```

First time it asks:
```
Are you sure you want to continue connecting (yes/no)?
```
Type `yes`, enter.

Then paste your password (nothing shows when you type, that's normal).

**Windows:** Use [PuTTY](https://putty.org). Same fingerprint question, click Yes.

## 3. Install

```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | bash
```

Done.

**Configuration options:**
- `-m` max clients (default: 200)
- `-b` bandwidth limit in Mbps (default: -1 = unlimited)

Custom install with 500 clients and 100 Mbps limit:
```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/install.sh | MAX_CLIENTS=500 BANDWIDTH=100 bash
```

Check it's running:
```bash
journalctl -u conduit -f
```

You should see stats like:
```
[STATS] Connected: 45 | Up: 2.3 GB | Down: 18.7 GB
```

## 4. Dashboard (optional)

Want a web UI to monitor your server?

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

cd /opt
git clone https://github.com/paradixe/conduit-relay.git conduit-dashboard
cd conduit-dashboard/dashboard

cp .env.example .env
nano .env  # set DASHBOARD_PASSWORD
```

Create `servers.json`:
```json
[
  { "name": "server1", "host": "YOUR_IP", "user": "root" }
]
```

```bash
npm install
npm start
```

Hit `http://YOUR_IP:3000`.

## 5. Multiple servers?

Set up SSH keys so you don't need passwords.

**On your laptop (once):**
```bash
mkdir -p ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
```

**See your public key:**
```bash
cat ~/.ssh/id_ed25519.pub
```
Copy this.

**Add it to your server** (SSH in first, then):
```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "PASTE_YOUR_KEY_HERE" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
```

Or if you have `ssh-copy-id` (easier):
```bash
ssh-copy-id root@SERVER1_IP
```

Then use fleet.sh:
```bash
./fleet.sh add server1 1.2.3.4
./fleet.sh add server2 5.6.7.8
./fleet.sh status
./fleet.sh update all
```

## Help

Open an issue: https://github.com/paradixe/conduit-relay/issues
