# Arquitectura de Storage con Backblaze B2

Documenta el sistema de almacenamiento de archivos (fotos, videos, audio, documentos) implementado originalmente en una aplicación de producción (SvelteKit + Backblaze B2), del cual se extrajo y generalizó Vaulter. El diseño es agnóstico del framework: los mismos principios y la misma librería central (`storage.ts`) aplican a Express, Fastify, Next.js, Hono, o cualquier servidor Node.js.

---

## Principios de diseño

### 1. Bucket 100% privado

El bucket de B2 se crea con visibilidad **Private**. Esto significa:

- Ningún archivo tiene URL pública directa (`https://f005.backblazeb2.com/...` no funciona)
- No existe riesgo de acceso no autorizado directo al storage
- No se necesitan políticas de bucket complejas ni presigned URLs
- El egress de B2 es gratuito cuando el servidor proxy está en la misma región (compatible con Cloudflare CDN)

### 2. Keys en la base de datos, no URLs

La base de datos **nunca guarda URLs completas de B2**. Guarda la **key** (path dentro del bucket):

```
Correcto:   "bitacora/abc123/1748123456789-uuid.jpg"
Incorrecto: "https://s3.us-east-005.backblazeb2.com/mi-bucket/bitacora/abc123/1748123456789-uuid.jpg"
```

Las ventajas:
- Si el bucket, región o proveedor cambia, no hay que migrar datos en la DB
- Las keys son cortas y portables
- La URL final se construye en runtime según el entorno (dev/prod pueden usar diferentes proxies)

### 3. Proxy como único punto de acceso

**Ningún cliente accede directamente a B2.** Toda petición de media pasa por el servidor:

```
Navegador → GET /media/bitacora/abc123/foto.jpg
          → servidor verifica sesión activa
          → servidor hace GetObject a B2 (privado)
          → servidor transmite el stream al navegador
```

El proxy es el único lugar donde viven las credenciales de B2. El navegador nunca las ve.

### 4. `toMediaUrl()` como capa de indirección

Una función pura convierte cualquier key en la URL del proxy. También maneja URLs legacy (de proveedores anteriores) de forma transparente:

```typescript
toMediaUrl("bitacora/abc123/foto.jpg")    // → "/media/bitacora/abc123/foto.jpg"
toMediaUrl("https://uploadthing.com/...") // → "https://uploadthing.com/..." (URL legacy, pasa directo)
toMediaUrl(null)                          // → null
```

Esto desacopla la UI del mecanismo de storage concreto.

---

## Variables de entorno

```bash
# .env
B2_KEY_ID="005..."             # Application Key ID de Backblaze B2
B2_APPLICATION_KEY="K005..."   # Application Key secret de Backblaze B2
B2_BUCKET_NAME="mi-bucket-test" # Nombre del bucket (Private)
B2_ENDPOINT="s3.us-east-005.backblazeb2.com"  # Endpoint S3 de tu región (con o sin https://)

# Para el cron job de limpieza
CRON_SECRET="token-secreto"    # Bearer token para proteger /api/cron/media-cleanup
```

El endpoint de tu bucket aparece en la consola de Backblaze al crear el bucket, en "Endpoint" o "S3 Endpoint". Cada región tiene su propio endpoint (ej: `s3.us-west-004.backblazeb2.com`, `s3.eu-central-003.backblazeb2.com`).

---

## Dependencia

```bash
pnpm add @aws-sdk/client-s3
# o
npm install @aws-sdk/client-s3
```

Backblaze B2 es compatible con la API S3 de AWS. Se usa `@aws-sdk/client-s3` sin modificaciones especiales, solo apuntando al endpoint de B2 con `forcePathStyle: true`.

---

## Librería central: `storage.ts`

Este es el único archivo que habla directamente con B2. Todo lo demás importa desde aquí.

```typescript
// src/lib/server/storage.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand
} from '@aws-sdk/client-s3';

// En SvelteKit: import { B2_KEY_ID, ... } from '$env/static/private';
// En otros frameworks: const B2_KEY_ID = process.env.B2_KEY_ID!;
import { B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME, B2_ENDPOINT } from '$env/static/private';

// Asegurar que el endpoint tenga protocolo — B2_ENDPOINT puede venir con o sin https://
const endpoint = B2_ENDPOINT.startsWith('http') ? B2_ENDPOINT : `https://${B2_ENDPOINT}`;

const s3 = new S3Client({
  endpoint,
  region: 'auto',
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APPLICATION_KEY
  },
  // Backblaze B2 usa path-style URLs (bucket en el path, no en el subdominio)
  // sin esto: s3.send() falla con "bucket not found"
  forcePathStyle: true
});

// Sube un archivo y devuelve su key en el bucket — nunca una URL pública
export async function subirArchivo(file: File, carpeta: string): Promise<string> {
  const timestamp = Date.now();
  const ext = file.name.split('.').pop() ?? 'bin';
  const key = `${carpeta}/${timestamp}-${crypto.randomUUID()}.${ext}`;

  const buffer = await file.arrayBuffer();

  await s3.send(
    new PutObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
      Body: Buffer.from(buffer),
      ContentType: file.type || 'application/octet-stream'
      // Sin ACL: 'public-read' — el bucket es privado
    })
  );

  return key; // ej: "bitacora/abc123/1748123456789-550e8400-e29b-41d4-a716-446655440000.jpg"
}

// Sube múltiples archivos en paralelo
export async function subirArchivos(files: File[], carpeta: string): Promise<string[]> {
  return Promise.all(files.map((f) => subirArchivo(f, carpeta)));
}

// Elimina un archivo de B2 por su key
export async function eliminarArchivo(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key }));
}

// Obtiene un archivo de B2 con soporte de Range requests (necesario para seeking en videos)
// range: "bytes=0-1048576" | "bytes=5242880-" | undefined
export async function obtenerArchivo(key: string, range?: string) {
  return s3.send(
    new GetObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
      Range: range
    })
  );
}

// Convierte una key del bucket en URL para el proxy interno
// Maneja keys legacy de proveedores anteriores (URLs completas con http)
export function toMediaUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith('http')) return key; // URL legacy — sirve directo sin proxy
  return `/media/${key}`;
}
```

### Por qué `forcePathStyle: true`

AWS S3 usa virtual-hosted style por defecto: `https://{bucket}.s3.amazonaws.com/{key}`. Backblaze B2 no soporta ese formato — requiere path-style: `https://{endpoint}/{bucket}/{key}`. Sin `forcePathStyle: true`, el SDK intenta conectar a `mi-bucket-test.s3.us-east-005.backblazeb2.com` que no existe.

### Por qué `region: 'auto'`

Backblaze B2 ignora el campo `region` del cliente S3. Usar `'auto'` evita errores de validación del SDK mientras mantiene el código semánticamente correcto.

---

## Convención de naming de keys

```
{contexto}/{userId}/{timestamp}-{uuid}.{ext}
```

| Segmento | Ejemplo | Propósito |
|----------|---------|-----------|
| `contexto` | `bitacora`, `actividades/imagenes`, `actividades/abc123/archivos` | Organización lógica en el bucket, facilita auditoría |
| `userId` | `abc123` | Vincular el archivo a su propietario, sin relying en metadata del bucket |
| `timestamp` | `1748123456789` | Orden natural por fecha de subida, sin query a la DB |
| `uuid` | `550e8400-e29b-41d4-a716-446655440000` | Unicidad garantizada, previene colisiones entre uploads simultáneos del mismo usuario |
| `ext` | `jpg`, `mp4`, `pdf` | Necesario para que el proxy infiera el Content-Type correcto |

### Ejemplos reales

```
bitacora/abc123/1748123456789-uuid.jpg          ← foto en bitácora
bitacora/abc123/1748123456791-uuid.mp4          ← video en bitácora
actividades/imagenes/1748123456789-uuid.webp    ← logo de una actividad
actividades/video/1748123456789-uuid.mp4        ← video promo de actividad
actividades/abc456/archivos/1748123456789-uuid.pdf  ← archivo adjunto a actividad específica
```

---

## Proxy de media

El proxy es el corazón del sistema de seguridad. Reside en `src/routes/media/[...path]/+server.ts` (SvelteKit), pero el patrón aplica a cualquier framework:

```typescript
// src/routes/media/[...path]/+server.ts  (SvelteKit)
// En Express/Fastify: app.get('/media/*', handler)
import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { obtenerArchivo } from '$lib/server/storage';

export const GET: RequestHandler = async ({ params, locals, request }) => {
  // Verificación de sesión — primer layer de seguridad
  // hooks.server.ts ya redirige sin sesión, pero esta línea defiende en profundidad
  if (!locals.user) {
    error(401, 'No autorizado');
  }

  const key = params.path;                              // "bitacora/abc123/foto.jpg"
  const rangeHeader = request.headers.get('Range') ?? undefined;

  try {
    const objeto = await obtenerArchivo(key, rangeHeader);

    const headers: Record<string, string> = {
      'Content-Type': objeto.ContentType ?? 'application/octet-stream',
      // Caché privado en el navegador por 1 hora — no CDN, no cache compartida
      'Cache-Control': 'private, max-age=3600'
    };

    if (objeto.ContentLength) {
      headers['Content-Length'] = String(objeto.ContentLength);
    }
    if (objeto.ContentRange) {
      headers['Content-Range'] = objeto.ContentRange;
    }
    if (rangeHeader) {
      headers['Accept-Ranges'] = 'bytes';
    }

    return new Response(objeto.Body as ReadableStream, {
      status: rangeHeader ? 206 : 200,   // 206 Partial Content para Range requests
      headers
    });
  } catch {
    error(404, 'Archivo no encontrado');
  }
};
```

### Por qué Range requests importan para videos

Sin Range requests, el navegador debe descargar el video completo antes de poder reproducirlo. Con Range requests:

1. El navegador pide `Range: bytes=0-65536` para cargar el inicio y empezar a reproducir
2. Al hacer seeking al minuto 2:30, pide `Range: bytes=5242880-6291456` (solo ese fragmento)
3. El servidor responde `206 Partial Content` con `Content-Range: bytes 5242880-6291456/10485760`

Esto hace que los videos sean reproducibles aunque sean grandes, sin esperar la descarga completa.

### Headers importantes

| Header | Valor | Por qué |
|--------|-------|---------|
| `Content-Type` | `image/jpeg`, `video/mp4`, etc. | El navegador necesita saber cómo renderizar el archivo |
| `Cache-Control: private, max-age=3600` | Cache local 1h | Reduce requests repetidas al servidor sin exponer el archivo en CDNs compartidas |
| `Accept-Ranges: bytes` | Le dice al navegador que soportamos Range | El navegador solo envía `Range:` si sabe que el servidor lo soporta |
| `Content-Range` | `bytes 0-65536/10485760` | En respuesta 206, indica qué porción del archivo se está enviando |

---

## Seguridad en capas

El sistema tiene tres capas de protección independientes:

### Capa 1: `hooks.server.ts` — guard global

Ejecuta en **cada request** antes de llegar a cualquier ruta. Si no hay sesión activa, redirige a login. `/media/*` no está en la lista de rutas públicas, por lo que está protegida automáticamente.

```typescript
// hooks.server.ts (simplificado)
const RUTAS_PUBLICAS = [
  /^\/actividades\/[^/]+\/asistencia/,
  /^\/api\/cron\//,
  // /media/* NO está aquí → protegida
];

if (!event.locals.user && !esRutaPublica) {
  throw redirect(302, `${PUBLIC_WEB_URL}/signin`);
}
```

### Capa 2: Proxy — verificación explícita

El handler del proxy re-verifica `locals.user` independientemente del guard global. Esto es defensa en profundidad: si en el futuro alguien agrega `/media/*` a las rutas públicas por error, el proxy sigue denegando sin sesión.

### Capa 3: Permisos por feature — autorización

Cada feature verifica que el usuario tenga permiso para operar sobre el recurso específico:

```typescript
// Subir: solo el usuario autenticado puede subir a su propia carpeta
mediaUrls = await subirArchivos(rawFiles, `bitacora/${userId}`);  // userId de locals, no de params

// Eliminar: verificar que el post pertenece al usuario antes de borrar
if (entry.userId !== userId) return fail(403, 'No puedes eliminar este post.');

// Actividades: solo el creador o gerentes pueden subir archivos
if (!esGerente && actividad.userId !== userId) return fail(403, '...');
```

La clave: `userId` **siempre viene de `locals.dbUserId`** (validado por la sesión), nunca de `params` ni `formData`.

---

## Flujo completo de subida

```
1. Usuario selecciona archivos en el formulario (browser)
   │
2. form.submit() → multipart/form-data al servidor
   │
3. server action extrae los File objects de formData
   rawFiles = formData.getAll('media').filter(f => f instanceof File && f.size > 0)
   │
4. subirArchivos(rawFiles, `bitacora/${userId}`)
   → para cada file: PutObjectCommand a B2 (privado)
   → retorna array de keys: ["bitacora/abc123/1748...-uuid.jpg", ...]
   │
5. prisma.bitacoraEntry.create({ data: { mediaUrls: keys } })
   → la DB guarda KEYS, no URLs
   │
6. Al renderizar el feed: toMediaUrl(key) → "/media/bitacora/abc123/1748...-uuid.jpg"
   │
7. <img src="/media/bitacora/abc123/1748...-uuid.jpg">
   │
8. GET /media/bitacora/abc123/1748...-uuid.jpg
   → hooks.server.ts verifica sesión
   → proxy verifica sesión (segunda capa)
   → GetObjectCommand a B2
   → stream de respuesta al navegador
```

---

## Flujo de eliminación resiliente

El borrado en cloud storage puede fallar (timeout de red, rate limiting, error transitorio de B2). Para no dejar archivos huérfanos en el bucket, se usa el patrón **enqueue-first**:

```
1. Usuario elimina un post con fotos/videos
   │
2. PRIMERO: encolar todas las keys en MediaCleanupQueue
   prisma.mediaCleanupQueue.createMany({
     data: entry.mediaUrls.map(key => ({ key, reason: 'post_deleted' }))
   })
   → Las keys están ahora registradas como "pendientes de borrar"
   │
3. LUEGO: borrar el registro de la DB (el post desaparece de la UI)
   prisma.bitacoraEntry.delete({ where: { id: entryId } })
   │
4. INTENTAR borrado inmediato en B2 (best-effort, no bloqueante)
   const resultados = await Promise.allSettled(
     entry.mediaUrls.map(key => eliminarArchivo(key))
   )
   │
5a. Si tuvo éxito → sacar de la cola (el cron no necesita procesarla)
    prisma.mediaCleanupQueue.deleteMany({ where: { key: { in: borradasOk } } })
   │
5b. Si falló → se queda en la cola, el cron job la reintentará
```

### ¿Por qué encolar antes de borrar la DB?

Si el orden fuera al revés (borrar DB → encolar → borrar B2) y el proceso cae entre el borrado de DB y el encolado, las keys quedan huérfanas para siempre. Al encolar primero, hay garantía de que toda key a borrar está registrada incluso si el proceso muere inmediatamente después.

---

## Modelo de base de datos: MediaCleanupQueue

```prisma
model MediaCleanupQueue {
  id     String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid

  // Key del archivo en B2, ej: "bitacora/userId/1748123456789-uuid.jpg"
  key    String

  // Contexto de por qué se encoló — útil para logs y auditoría
  reason String @default("post_deleted")

  // Conteo de intentos de borrado fallidos
  attempts    Int       @default(0)
  lastTriedAt DateTime? @map("last_tried_at")

  // true cuando superó MAX_ATTEMPTS — requiere revisión manual
  failed      Boolean   @default(false)

  createdAt DateTime @default(now()) @map("created_at")

  @@index([failed, attempts]) // el cron filtra por estos dos campos
  @@map("media_cleanup_queue")
}
```

---

## Cron job de limpieza

Endpoint protegido que procesa la cola de archivos pendientes de borrar. Se configura para correr cada hora en el proveedor de hosting (Railway, Render, etc.):

```typescript
// src/routes/api/cron/media-cleanup/+server.ts
const MAX_ATTEMPTS = 5;

export const GET: RequestHandler = async ({ request }) => {
  // Protección con Bearer token — solo el cron configurado en Railway puede llamarlo
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const pendientes = await prisma.mediaCleanupQueue.findMany({
    where: { failed: false, attempts: { lt: MAX_ATTEMPTS } }
  });

  const resultados = await Promise.allSettled(
    pendientes.map((item) => eliminarArchivo(item.key))
  );

  for (let i = 0; i < pendientes.length; i++) {
    const item = pendientes[i];

    if (resultados[i].status === 'fulfilled') {
      // Borrado exitoso — sacar de la cola definitivamente
      await prisma.mediaCleanupQueue.delete({ where: { id: item.id } });
    } else {
      const nuevosIntentos = item.attempts + 1;
      const esDefinitivamenteFallido = nuevosIntentos >= MAX_ATTEMPTS;

      await prisma.mediaCleanupQueue.update({
        where: { id: item.id },
        data: {
          attempts: nuevosIntentos,
          lastTriedAt: new Date(),
          failed: esDefinitivamenteFallido   // después de 5 fallos → revisión manual
        }
      });

      if (esDefinitivamenteFallido) {
        console.error(`[media-cleanup] Archivo sin poder eliminar tras ${MAX_ATTEMPTS} intentos:`, item.key);
      }
    }
  }
};
```

**Configuración en Railway:**
```
Schedule: 0 * * * *   (cada hora)
Command:  curl -H "Authorization: Bearer $CRON_SECRET" https://tu-app.railway.app/api/cron/media-cleanup
```

Los archivos marcados como `failed: true` (superaron 5 intentos) requieren revisión manual en Prisma Studio o directamente en la consola de B2 para verificar si existen y borrarlos.

---

## Integración con la base de datos

### Dónde se guardan las keys en el schema

```prisma
model BitacoraEntry {
  mediaUrls String[] @default([]) @map("media_urls")
  // Array de keys: ["bitacora/abc123/foto1.jpg", "bitacora/abc123/video.mp4"]
}

model Activity {
  logoUrl  String?   // key de B2 o URL legacy
  videoUrl String?   // key de B2 o URL legacy
  patchUrl String?   // key de B2 o URL legacy
}

model ActivityFile {
  url      String    // key de B2 (o URL legacy de UploadThing)
  mimeType String    // 'image/jpeg', 'video/mp4', etc.
  size     Int       // bytes
}
```

### Compatibilidad con URLs legacy

Durante la migración desde UploadThing, algunas filas en la DB tienen URLs completas (`https://utfs.io/...`). La función `toMediaUrl()` las detecta y las devuelve sin modificar:

```typescript
export function toMediaUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith('http')) return key;  // URL legacy — no necesita proxy
  return `/media/${key}`;                  // key de B2 — redirigir al proxy
}
```

Esto permite que el sistema funcione con datos mixtos sin migraciones de datos.

---

## Detección de tipo de media por extensión

Para mostrar el ícono/componente correcto en la UI según el tipo de archivo, se usa detección por extensión de la key (o URL):

```typescript
// src/lib/server/bitacora.queries.ts
function detectarTipoMedia(
  mediaUrls: string[]
): 'foto' | 'video' | 'audio' | 'archivo' | null {
  if (mediaUrls.length === 0) return null;
  const url = mediaUrls[0].toLowerCase();
  if (/\.(mp4|webm|mov|avi|mkv)(\?|$)/.test(url)) return 'video';
  if (/\.(mp3|wav|ogg|m4a|flac|aac)(\?|$)/.test(url)) return 'audio';
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif|heic)(\?|$)/.test(url)) return 'foto';
  return 'archivo';
}

// Para discriminar video/imagen en componentes del feed
const VIDEO_EXTS = /\.(mp4|webm|mov|avi|mkv)$/i;
const isVideo = VIDEO_EXTS.test(url);
```

La detección se aplica a la key directamente — como la key incluye la extensión original (`...uuid.mp4`), funciona sin necesidad de consultar metadata del bucket.

---

## Configuración del bucket en Backblaze

Pasos para crear el bucket correctamente:

1. Ir a [backblaze.com](https://www.backblaze.com) → My Account → Buckets
2. **Create a Bucket** con visibilidad **Private** (no Public)
3. Anotar el **Endpoint** del bucket (aparece en los detalles del bucket)
4. Ir a **App Keys** → **Add a New Application Key**:
   - Allow access to: solo este bucket (no "All Buckets")
   - Type of access: Read and Write
   - Anotar `keyID` → `B2_KEY_ID`
   - Anotar `applicationKey` → `B2_APPLICATION_KEY` (solo se muestra una vez)

> Si en algún momento el bucket fue configurado como Public por error, cambiar a Private en la consola. Las URLs de B2 preexistentes dejarán de funcionar inmediatamente, pero el proxy no se ve afectado.

---

## Guía de portabilidad (frameworks alternativos)

La librería `storage.ts` es Node.js puro — no depende de SvelteKit. Para usarla en otros frameworks:

### Express / Fastify

```typescript
// Solo cambiar el import de variables de entorno:
const B2_KEY_ID = process.env.B2_KEY_ID!;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY!;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME!;
const B2_ENDPOINT = process.env.B2_ENDPOINT!;

// El resto de storage.ts es idéntico
```

Proxy en Express:
```typescript
app.get('/media/*', requireAuth, async (req, res) => {
  const key = req.params[0];  // todo después de /media/
  const range = req.headers.range;
  try {
    const objeto = await obtenerArchivo(key, range);
    res.setHeader('Content-Type', objeto.ContentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (range) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.status(206);
    }
    (objeto.Body as NodeJS.ReadableStream).pipe(res);
  } catch {
    res.status(404).send('Archivo no encontrado');
  }
});
```

### Next.js App Router

```typescript
// app/media/[...path]/route.ts
export async function GET(req: Request, { params }: { params: { path: string[] } }) {
  const session = await getServerSession(); // tu auth de Next.js
  if (!session) return new Response('Unauthorized', { status: 401 });

  const key = params.path.join('/');
  const range = req.headers.get('Range') ?? undefined;
  const objeto = await obtenerArchivo(key, range);

  const headers = new Headers({
    'Content-Type': objeto.ContentType ?? 'application/octet-stream',
    'Cache-Control': 'private, max-age=3600',
  });

  return new Response(objeto.Body as ReadableStream, {
    status: range ? 206 : 200,
    headers
  });
}
```

### Hono (Cloudflare Workers / Bun)

```typescript
app.get('/media/*', authMiddleware, async (c) => {
  const key = c.req.param('*');  // todo después de /media/
  const range = c.req.header('Range');
  const objeto = await obtenerArchivo(key, range);
  // mismo patrón de headers
});
```

---

## Checklist de implementación

Al implementar este sistema en un nuevo proyecto:

- [ ] Crear bucket en Backblaze con visibilidad **Private**
- [ ] Crear Application Key con acceso solo a ese bucket
- [ ] Agregar las 4 variables de entorno (`B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`, `B2_ENDPOINT`)
- [ ] Agregar `CRON_SECRET` para el cron job de limpieza
- [ ] Instalar `@aws-sdk/client-s3`
- [ ] Copiar `storage.ts` ajustando el import de variables de entorno
- [ ] Crear el endpoint proxy `/media/[...path]` con verificación de sesión
- [ ] Crear la tabla `media_cleanup_queue` en la base de datos
- [ ] Crear el endpoint del cron job protegido con Bearer token
- [ ] En los features: usar `subirArchivo(file, carpeta)` → guardar key → `toMediaUrl(key)` en cliente
- [ ] Verificar que el bucket NO tiene acceso público directo (ninguna URL de B2 funciona sin el proxy)
- [ ] Configurar el cron en el hosting (`0 * * * *` o más frecuente si hay mucho volumen)
