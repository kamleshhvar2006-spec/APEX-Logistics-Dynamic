# APEX Logistics on Zoho Catalyst

```
Browser ──► Catalyst Web Client Hosting  (client/index.html, served at /app/)
   │
   └──► /server/apex_api/...  (Advanced I/O function, Node.js + Express)  ──► Data Store (Shipments, Fleet)
```

The site and the function share one domain, so there is no CORS setup.

## Files

| File | Goes to |
|---|---|
| `functions/apex_api/index.js` | replaces `index.js` in the function the CLI creates |
| `client/index.html`, `client/client-package.json` | replace the files in the `client` folder the CLI creates |
| `tools/make_admin_hash.js` | run once on your computer to make the admin secrets |

## Data Store tables (create in the console; names and columns are case-sensitive)

**Shipments**

| Column | Type | Notes |
|---|---|---|
| `trackingId` | Var Char (40) | Is Unique, Is Mandatory |
| `shipStatus` | Var Char (30) | |
| `customerName` | Var Char (100) | |
| `email` | Var Char (150) | |
| `origin`, `destination` | Var Char (40) | |
| `currentLocation` | Var Char (150) | |
| `transportMode` | Var Char (10) | |
| `weightKg`, `estimatedCost` | Double | |
| `estimatedDelivery` | Var Char (20) | |
| `createdAt`, `updatedAt` | Var Char (30) | |

**Fleet**: `vehicleId` (Var Char 20, Is Unique), `vehicleType`, `vehicleName`, `vehicleStatus`, `vehicleLocation` (Var Char 100 each).

## Environment variables (function `apex_api` → Configuration → Environment Variables)

| Name | Value |
|---|---|
| `ADMIN_EMAIL` | the email you will type on the admin login form |
| `ADMIN_PASSWORD_HASH` | printed by `node tools/make_admin_hash.js "YourPassword"` |
| `SESSION_SECRET` | printed by the same command |

## Commands

```bash
npm install -g zcatalyst-cli
catalyst login
mkdir apex-catalyst-app && cd apex-catalyst-app
catalyst init            # pick your project; add Functions (AdvancedIO, Node.js, name apex_api) and Client
cd functions/apex_api && npm install express@4 && cd ../..
# copy the files from the table above, then:
catalyst deploy
```

Development environment is free and gives a public URL containing `.development.`. Production needs a payment method in Catalyst and the **Deploy to Production** button in the console.

## Limits worth knowing

- Advanced I/O functions time out after 30 seconds.
- ZCQL returns at most 300 rows per query. The dashboard pages through them and stops at 6,000 shipments; past that, add date filters.
- The login lockout (8 failures per 15 minutes) is kept in function memory, so it is best-effort. For a hard limit, put Catalyst API Gateway throttling on `/server/apex_api/admin/login`.
- Admin login is a single account with no MFA. If several staff need access, switch to Catalyst Authentication.
