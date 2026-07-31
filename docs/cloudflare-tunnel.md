# Cloudflare Tunnel — referencia para api.lumiadalistore.com
#
# El tunnel corre en el HOST (Windows / ThinkCentre), NO dentro del contenedor API.

## Arquitectura

```
https://api.lumiadalistore.com
        ↓
   Cloudflare Edge
        ↓
   cloudflared (servicio del SO)
        ↓
   http://localhost:3001  ← Docker expone el puerto de la API
```

## 1. Instalar cloudflared (Windows)

```powershell
winget install Cloudflare.cloudflared
```

## 2. Autenticar

```powershell
cloudflared tunnel login
```

## 3. Crear el tunnel

```powershell
cloudflared tunnel create lumia-api
```

Anota el **Tunnel ID** y el archivo `.json` de credenciales.

## 4. Configurar ingress

Crear `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: C:\Users\<usuario>\.cloudflared\<TUNNEL_ID>.json

ingress:
  - hostname: api.lumiadalistore.com
    service: http://localhost:3001
  - service: http_status:404
```

## 5. DNS en Cloudflare

```powershell
cloudflared tunnel route dns lumia-api api.lumiadalistore.com
```

O manualmente: CNAME `api` → `<TUNNEL_ID>.cfargotunnel.com`

## 6. Ejecutar

```powershell
cloudflared tunnel run lumia-api
```

## 7. Instalar como servicio Windows

```powershell
cloudflared service install
cloudflared tunnel run lumia-api
```

## 8. Verificar

```powershell
curl https://api.lumiadalistore.com/health
curl https://api.lumiadalistore.com/api/products
```

## Migración al ThinkCentre

1. Instalar Docker, Docker Compose, cloudflared
2. Copiar proyecto + `.env.production`
3. `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`
4. Copiar `%USERPROFILE%\.cloudflared\` al ThinkCentre
5. Iniciar servicio cloudflared en el ThinkCentre
6. Apagar el PC anterior

No cambiar: DNS, dominio, JWT_SECRET, frontend, endpoints.
