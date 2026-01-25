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

**نکته:** سرورای ارزون معمولاً ماهی $3-5 هستن. GeorgeDataCenter, RackNerd خوبن.

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
[PuTTY](https://putty.org) رو دانلود کن، IP رو بزن، وصل شو.

---

## ۳. نصب (یه دستور)

این رو کپی پیست کن:
```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/setup.sh | bash
```

صبر کن تا تموم بشه. آخرش یه چیزی مثل این میبینی:

```
════════════════════════════════════════════════════════════
                    Setup Complete!
════════════════════════════════════════════════════════════

  Dashboard:  http://123.45.67.89:3000
  Password:   ABC123xyz

  Save this password! It won't be shown again.

════════════════════════════════════════════════════════════
  To add other servers, run this on each:

  curl -sL "http://123.45.67.89:3000/join/abc123..." | bash

════════════════════════════════════════════════════════════
```

**مهم:** پسورد رو یه جا ذخیره کن!

---

## ۴. داشبورد

برو توی مرورگر:
```
http://123.45.67.89:3000
```

پسورد رو بزن. تمام! حالا وضعیت سرورت رو میبینی.

---

## ۵. سرور دیگه اضافه کردن

اگه چند سرور داری، کارت خیلی راحته:

۱. SSH بزن به سرور جدید
۲. اون دستور `curl ... /join/...` که بعد نصب دیدی رو بزن
۳. تمام! خودکار وصل میشه به داشبورد

هر چند تا سرور که داشته باشی، همین دستور رو روشون بزن. خودشون نصب میشن و وصل میشن.

---

## تنظیمات پیشرفته

اگه میخوای تعداد کلاینت یا پهنای باند رو تغییر بدی:

```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/setup.sh | MAX_CLIENTS=500 BANDWIDTH=100 bash
```

- `MAX_CLIENTS`: حداکثر کلاینت همزمان (پیش‌فرض: 200)
- `BANDWIDTH`: محدودیت سرعت به Mbps (پیش‌فرض: -1 = نامحدود)

**از داشبورد:**
- روی هر سرور دکمه Edit بزن
- محدودیت ماهانه (TB) بذار - اتوماتیک وقتی رسید خاموش میشه
- اسم سرور رو عوض کن
- سرور رو حذف کن

**آپدیت:**
از Settings داشبورد، دکمه Update Dashboard بزن. همه چیز آپدیت میشه.

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

First time it asks about fingerprint - type `yes`, enter. Then paste password.

**Windows:** Use [PuTTY](https://putty.org).

## 3. Install (One Command)

```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/setup.sh | bash
```

After it finishes you'll see:
- **Dashboard URL** - Open in browser
- **Password** - Save it!
- **Join command** - For adding other servers

## 4. Dashboard

Open the dashboard URL in your browser, enter the password. Done!

## 5. Adding More Servers

Have multiple servers? Easy:

1. SSH into the new server
2. Run the join command that was shown after setup
3. Done - it auto-connects to your dashboard

Run the same join command on any server to add it.

## Advanced Config

Custom client/bandwidth limits:
```bash
curl -sL https://raw.githubusercontent.com/paradixe/conduit-relay/main/setup.sh | MAX_CLIENTS=500 BANDWIDTH=100 bash
```

- `MAX_CLIENTS`: Max concurrent clients (default: 200)
- `BANDWIDTH`: Speed limit in Mbps (default: -1 = unlimited)

**From the dashboard:**
- Click Edit on any server
- Set monthly bandwidth limit (TB) - auto-stops when exceeded
- Rename servers
- Delete servers from monitoring

**Updates:**
Settings > Update Dashboard. Updates everything in one click.

## Help

Open an issue: https://github.com/paradixe/conduit-relay/issues
