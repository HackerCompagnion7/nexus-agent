# JARVIS — Asistente Autónomo de Voz

Agente autónomo impulsado por voz usando **Mistral Small** via Mistral API. Diseñado para **Termux/Android** con cero dependencias externas.

## Dos Modos

| Modo | Comando | Interfaz |
|------|---------|----------|
| **CLI** | `node index.js` | Escribe comandos y tareas en Termux |
| **Web** | `node index.js --web` | Solo voz — orbe, escuchar, hablar |

## Inicio Rápido

```bash
# 1. Instalar
bash install.sh

# 2. Configurar API key (obtener en https://console.mistral.ai/)
export MISTRAL_API_KEY="tu-key"

# 3. Ejecutar CLI (escribir comandos)
node index.js

# 4. Ejecutar Web (solo voz)
node index.js --web
```

## Arquitectura

| Módulo | Descripción |
|--------|-------------|
| `llm.js` | API shim — streaming, retry, rate limiting, tool call parsing |
| `tools.js` | 12 herramientas — archivos, shell, web, código |
| `memory.js` | Memoria persistente — extracción de hechos, auto-consolidación |
| `coordinator.js` | Multi-agente — descomposición de tareas, ejecución paralela |
| `index.js` | Máquina de estados — CLI, web server, agent loop |
| `system.md` | Prompt del sistema — protocolo de agente autónomo |
| `web/index.html` | PWA solo-voz — orbe, reconocimiento de voz, TTS |
| `web/manifest.json` | Manifest PWA — instalación como app |
| `web/sw.js` | Service Worker — persistencia en segundo plano |

## Comandos CLI

### Generales

| Comando | Descripción |
|---------|-------------|
| `/status` | Estado del agente |
| `/apikey` | Cambiar API key |
| `/memory` | Estadísticas de memoria |
| `/consolidate` | Ejecutar consolidación de memoria |
| `/clear` | Limpiar historial de conversación |
| `/help` | Mostrar ayuda |
| `/exit` | Salir |

### Gestión de Archivos

| Comando | Descripción |
|---------|-------------|
| `/ls [path]` | Listar contenido del directorio |
| `/cd [path]` | Cambiar directorio de trabajo |
| `/cat [file]` | Leer contenido de archivo |
| `/rm [path]` | Eliminar archivo |
| `/mv [src] [dst]` | Mover/renombrar archivo |
| `/find [patrón]` | Buscar archivos por nombre |
| `/space` | Mostrar uso de disco |
| `/organize [dir]` | Organizar directorio por tipo de archivo |

### Comandos en Lenguaje Natural

También puedes escribir tareas en lenguaje natural:
- "organiza mi almacenamiento interno"
- "busca archivos PDF en Descargas"
- "muestra el espacio libre"
- "lee el archivo config.json"
- "escribe un archivo notas.txt con..."

## Web — Modo Solo Voz

La interfaz web es **100% voz**:
- **Orbe central** — Toca para hablar
- **Escucha** — SpeechRecognition API (Chrome/Android)
- **Habla** — SpeechSynthesis API con voz en español
- **Auto-listen** — Escucha automáticamente después de cada respuesta
- **PiP** — Bubble flotante al salir de la app (Document PiP API)
- **Wake Lock** — Mantiene la pantalla activa
- **Service Worker** — Persistencia en segundo plano
- **PWA** — Instalable como app nativa

## Herramientas

`file_read` · `file_write` · `file_list` · `file_search` · `file_delete` · `file_move` · `shell_exec` · `web_fetch` · `web_search` · `system_info` · `code_eval` · `memory_query`

## Requisitos

- Node.js 18+ (cero dependencias npm)
- Mistral API key (https://console.mistral.ai/)
- Navegador Chrome/Android para modo web (SpeechRecognition)

## Licencia

MIT
