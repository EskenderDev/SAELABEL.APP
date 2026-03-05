# Guía de Despliegue, Actualización y Servicio de SAE.STUDIO

Esta guía documenta la arquitectura de empaquetado de SAE.STUDIO, cómo funciona el actualizador automático (Tauri Updater), y los pasos necesarios para publicar nuevas versiones.

---

## 🏛️ Arquitectura de Distribución

La aplicación final se distribuye como un único instalador de Windows (MSI/NSIS) que contiene dos componentes principales:

1.  **Frontend (Tauri / React):** La interfaz gráfica de usuario.
2.  **Backend (.NET Core):** El servidor que procesa las plantillas XML y domina la lógica de impresión y renderizado, empaquetado como un *Sidecar* (un ejecutable secundario).

### Instalación como Servicio de Windows

Al ejecutar el instalador NSIS generado por Tauri, ocurren varias acciones clave configuradas a través de *NSIS Hooks* (`src-tauri/windows/hooks.nsh`):

*   **Pre-Instalación:** Detiene y elimina versiones anteriores del servicio `SAE.STUDIO.Api` si existen.
*   **Instalación:** Extrae el ejecutable sidecar `.NET` (`server.exe`) en la carpeta del sistema.
*   **Post-Instalación:** Registra e inicia el servicio `SAE.STUDIO.Api` usando `sc.exe`, configurado en el puerto **`5117`** (HTTP Localhost) por defecto. Se establece para inicio automático y con reglas de auto-recuperación.
*   **Desinstalación:** El servicio se detiene y se elimina limpiamente del sistema.

---

## 🔄 Actualizaciones Automáticas (Tauri Updater)

SAE.STUDIO utiliza **Tauri Updater** integrado con GitHub Releases:
`https://github.com/EskenderDev/SAE.STUDIO.APP/releases/latest/download/latest.json`.

Todas las actualizaciones están firmadas criptográficamente con el algoritmo **ED25519**.

### 🔐 Seguridad y Claves

1.  **Clave Pública:** Incrustada en `tauri.conf.json`. Firma la confianza del paquete descargado.
2.  **Clave Privada (`updater.key`):** Almacenada localmente en `src-tauri/`. **NUNCA la subas a Git**. Es la llave maestra que permite a tus usuarios confiar en las actualizaciones automáticas.

### ⚙️ Configuración en GitHub Actions

Para automatizar los lanzamientos, debes configurar estos **Secrets** en tu repositorio de GitHub (`Settings -> Secrets -> Actions`):

- **`GITHUB_TOKEN`:** Automático por GitHub.
- **`TAURI_SIGNING_PRIVATE_KEY`:** El contenido de tu archivo local `updater.key`.
- **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`:** La clave de tu archivo (si generaste una).

---

## 🚀 Cómo Publicar una Nueva Versión

El proceso de CI/CD es automático a través de GitHub Actions.

### Pasos para un Lanzamiento (Release):

1.  **Versión:** Actualiza la versión en `package.json` y `src-tauri/tauri.conf.json` simultáneamente.
2.  **Tag:** Crea una nueva etiqueta de Git y súbela:
    ```bash
    git add .
    git commit -m "chore: release version 0.3.0"
    git tag v0.3.0
    git push origin master v0.3.0 --tags
    ```

### El Proceso Automático
GitHub Actions realizará:
1. Compilación cruzada del frontend (Astro).
2. Descarga y compilación del backend desde el repositorio **`EskenderDev/SAE.STUDIO`**.
3. Bundling del Sidecar .NET en el instalador de Windows.
4. Firmado digital y publicación del release en la pestaña de **Releases** de GitHub.

---
© 2026 **EskenderDev** | SAE.STUDIO Ecosystem
