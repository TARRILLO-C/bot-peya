# 🎭 Avatar Facial — Control por Voz

Web que muestra tu rostro y reacciona a comandos de voz con gestos fluidos y naturales.

---

## ✅ Características

- 🎤 **Reconocimiento de voz** en español — sin APIs de pago
- 🔀 **Crossfade suave** entre videos (no se nota el corte)
- 💾 **Guarda tus videos en el navegador** (IndexedDB) — no se borran al recargar
- 📱 Responsive — funciona en PC y móvil
- 🌐 100% estático — no necesita servidor

---

## 🎬 Comandos de voz

| Dices...                   | Acción                    |
|----------------------------|---------------------------|
| `"izquierda"`              | Reproduce giro a la izquierda |
| `"derecha"`                | Reproduce giro a la derecha   |
| `"sonríe"` / `"sonrisa"`   | Reproduce gesto de sonrisa    |

---

## 📷 Cómo grabar los videos

Para que la ilusión funcione:

1. **Fondo liso** (pared blanca o color sólido)
2. **Misma iluminación** en todos los videos
3. Cada gesto **empieza y termina en posición neutral** (mirando al frente)
4. **Duración**: 1–2 segundos por gesto; idle: 3–5 segundos en loop
5. **Formato**: MP4, 720p o 1080p, 30fps

---

## 🚀 Deploy gratuito en GitHub Pages

### Paso 1 — Crear repositorio en GitHub
```
1. Ve a https://github.com/new
2. Nombre: mi-avatar (o el que prefieras)
3. Tipo: Público
4. Clic en "Create repository"
```

### Paso 2 — Subir archivos
```
1. En el repositorio, clic en "uploading an existing file"
2. Arrastra estos archivos:
   - index.html
   - style.css
   - app.js
3. Clic en "Commit changes"
```

> **Nota:** Los videos NO se suben a GitHub — se cargan directamente desde tu dispositivo
> usando la interfaz de la web y se guardan en el navegador (IndexedDB).

### Paso 3 — Activar GitHub Pages
```
1. Ve a Settings → Pages
2. Branch: main → Folder: / (root)
3. Clic en "Save"
4. Espera 1–2 minutos
```

### Paso 4 — ¡Tu URL lista!
```
https://TU-USUARIO.github.io/mi-avatar
```

---

## 🌐 Navegadores compatibles

| Navegador       | Soporte |
|-----------------|---------|
| Google Chrome   | ✅ Completo |
| Microsoft Edge  | ✅ Completo |
| Safari (iOS)    | ⚠️ Parcial (sin speech continuo) |
| Firefox         | ❌ No soporta Web Speech API |

> **Recomendado: Google Chrome** para la mejor experiencia.

---

## 📁 Estructura del proyecto

```
mi-avatar/
├── index.html   ← Página principal
├── style.css    ← Estilos y animaciones
├── app.js       ← Lógica de voz + videos
└── README.md    ← Este archivo
```

---

## 🛠️ Tecnología usada

- **Web Speech API** — reconocimiento de voz nativo (gratis, sin API key)
- **IndexedDB** — almacenamiento de videos en el navegador
- **HTML5 Video** — reproducción con crossfade (CSS opacity transition)
- **GitHub Pages** — hosting estático gratuito
