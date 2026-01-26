# Portainer Setup Guide / راهنمای نصب با Portainer

Run Conduit on OrangePi, Raspberry Pi, or any ARM/x86 device with Docker and Portainer.

---

## English

### Requirements

- OrangePi, Raspberry Pi, or any Linux device
- Docker installed
- Portainer installed
- ARM64 or AMD64 architecture

### Option 1: Relay Only (No Dashboard)

1. **Portainer → Stacks → Add Stack**
2. **Name:** `conduit`
3. **Paste this compose:**

```yaml
version: '3.8'
services:
  relay:
    image: ghcr.io/ssmirr/conduit/conduit:latest
    container_name: conduit-relay
    restart: unless-stopped
    command: ["start", "-m", "200", "-b", "-1", "--data-dir", "/home/conduit/data", "-v"]
    volumes:
      - relay-data:/home/conduit/data
    network_mode: host

volumes:
  relay-data:
```

4. **Deploy**

### Option 2: Relay + Dashboard

1. **Portainer → Stacks → Add Stack**
2. **Name:** `conduit`
3. **Paste this compose:**

```yaml
version: '3.8'
services:
  relay:
    image: ghcr.io/ssmirr/conduit/conduit:latest
    container_name: conduit-relay
    restart: unless-stopped
    command: ["start", "-m", "200", "-b", "-1", "--data-dir", "/home/conduit/data", "-v"]
    volumes:
      - relay-data:/home/conduit/data
    network_mode: host

  dashboard:
    image: ghcr.io/paradixe/conduit-dashboard:latest
    container_name: conduit-dashboard
    restart: unless-stopped
    environment:
      - PORT=3000
      - DASHBOARD_PASSWORD=CHANGE_THIS_PASSWORD
      - SESSION_SECRET=CHANGE_THIS_TO_RANDOM_STRING
      - JOIN_TOKEN=CHANGE_THIS_TO_RANDOM_STRING
    volumes:
      - dashboard-data:/opt/conduit-dashboard/data
    ports:
      - "3000:3000"

volumes:
  relay-data:
  dashboard-data:
```

4. **Before deploying, change these values:**
   - `DASHBOARD_PASSWORD` - Your login password
   - `SESSION_SECRET` - Random string (use: `openssl rand -hex 32`)
   - `JOIN_TOKEN` - Random string for adding servers (use: `openssl rand -hex 16`)

5. **Deploy**

6. **Access dashboard:** `http://YOUR_IP:3000`

### Viewing Logs

- **Portainer → Containers → conduit-relay → Logs**
- Look for `STATS` lines showing connected clients

### Updating

- **Portainer → Stacks → conduit → Editor → Pull and redeploy**

---

## فارسی

### پیش‌نیازها

- OrangePi، Raspberry Pi، یا هر دستگاه لینوکسی
- Docker نصب شده
- Portainer نصب شده
- معماری ARM64 یا AMD64

### روش ۱: فقط ریلی (بدون داشبورد)

۱. **برو به Portainer → Stacks → Add Stack**
۲. **اسم:** `conduit`
۳. **این رو paste کن:**

```yaml
version: '3.8'
services:
  relay:
    image: ghcr.io/ssmirr/conduit/conduit:latest
    container_name: conduit-relay
    restart: unless-stopped
    command: ["start", "-m", "200", "-b", "-1", "--data-dir", "/home/conduit/data", "-v"]
    volumes:
      - relay-data:/home/conduit/data
    network_mode: host

volumes:
  relay-data:
```

۴. **Deploy رو بزن**

### روش ۲: ریلی + داشبورد

۱. **برو به Portainer → Stacks → Add Stack**
۲. **اسم:** `conduit`
۳. **این رو paste کن:**

```yaml
version: '3.8'
services:
  relay:
    image: ghcr.io/ssmirr/conduit/conduit:latest
    container_name: conduit-relay
    restart: unless-stopped
    command: ["start", "-m", "200", "-b", "-1", "--data-dir", "/home/conduit/data", "-v"]
    volumes:
      - relay-data:/home/conduit/data
    network_mode: host

  dashboard:
    image: ghcr.io/paradixe/conduit-dashboard:latest
    container_name: conduit-dashboard
    restart: unless-stopped
    environment:
      - PORT=3000
      - DASHBOARD_PASSWORD=یه_پسورد_بذار
      - SESSION_SECRET=یه_رشته_تصادفی_بذار
      - JOIN_TOKEN=یه_رشته_تصادفی_دیگه
    volumes:
      - dashboard-data:/opt/conduit-dashboard/data
    ports:
      - "3000:3000"

volumes:
  relay-data:
  dashboard-data:
```

۴. **قبل از Deploy این مقادیر رو عوض کن:**
   - `DASHBOARD_PASSWORD` - پسورد ورود به داشبورد
   - `SESSION_SECRET` - یه رشته تصادفی (با این دستور بساز: `openssl rand -hex 32`)
   - `JOIN_TOKEN` - یه رشته تصادفی برای اضافه کردن سرورها (با این بساز: `openssl rand -hex 16`)

۵. **Deploy رو بزن**

۶. **داشبورد:** `http://IP_دستگاهت:3000`

### دیدن لاگ‌ها

- **برو به Portainer → Containers → conduit-relay → Logs**
- دنبال خطوط `STATS` بگرد که تعداد کلاینت‌ها رو نشون میده

### آپدیت کردن

- **برو به Portainer → Stacks → conduit → Editor → Pull and redeploy**

---

## Troubleshooting / مشکلات رایج

**Container won't start / کانتینر استارت نمیشه:**
- Check architecture: `uname -m` (should be `aarch64` or `x86_64`)
- Check logs in Portainer

**No clients connecting / کلاینت وصل نمیشه:**
- Make sure `network_mode: host` is set
- Check firewall allows UDP traffic

**Dashboard not accessible / داشبورد باز نمیشه:**
- Check port 3000 is not blocked
- Try `http://IP:3000` not https
