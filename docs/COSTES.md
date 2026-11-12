# 💶 Costes, límites y control del gasto

> **Configuración por defecto = 0 €.** Las secciones sobre Claude/Anthropic solo aplican si eliges `LLM_PROVIDER=anthropic`. Con Groq el límite real es el cupo gratuito diario (el bot se detiene solo al agotarlo; `DAILY_TOKEN_BUDGET=150000` va por debajo de los 200.000 tokens/día de Groq).

> Los planes gratuitos y sus límites **pueden cambiar**. Verifica siempre las páginas oficiales de precios antes de depender de ellos. Aquí no se dan precios de la API de Claude porque cambian: consúltalos en la página de precios de Anthropic.

## Qué es gratis y qué puede costar

| Parte | Coste | Notas |
|---|---|---|
| Vercel Hobby | Gratis | Plan para uso **personal/no comercial**. Tiene límites de ejecuciones, tiempo y transferencia. Si los superas, puede bloquear el proyecto hasta que se restablezca (no te cobra solo). Si tu servidor es de pago o monetizas, revisa sus términos. |
| GitHub Actions | Gratis en repo **público** | En repo **privado** hay un cupo mensual de minutos (en el plan gratuito, del orden de 2.000). Este bot hace unas 600 ejecuciones/día de pocos segundos (cada una se redondea a 1 minuto) → un repo privado agotaría el cupo. Usa repo público. |
| Supabase Free | Gratis | Límites de tamaño de base de datos y de proyectos; los proyectos inactivos se pausan. El bot guarda poco texto. En `schema.sql` hay consultas para limpiar datos antiguos. |
| Discord | Gratis | Límite de peticiones por segundo; el bot publica pocos mensajes. |
| RSS / calendario | Gratis | Sin garantías de disponibilidad. |
| **IA: Groq (por defecto)** | Gratis | Plan gratuito con límites por día y por minuto (en el modelo por defecto, según fuentes de terceros consultadas en 2026: unas 1.000 peticiones y 200.000 tokens al día). Pueden cambiar. Sin tarjeta según esas fuentes: compruébalo al registrarte. |
| IA: Claude (opcional) | 💰 De pago, por uso | Solo si cambias `LLM_PROVIDER=anthropic`. |

Con la configuración por defecto (Groq) ninguna parte pide pagar. Los posibles costes extra aparecerían solo si **tú** pasas a un plan de pago de Vercel/GitHub/Supabase.

## Cuántas consultas mensuales a Claude (estimación)

Con la configuración por defecto:

| Concepto | Límite | Consultas/mes (máximo) |
|---|---|---|
| Análisis de noticias | 40 al día (`MAX_ANALYSES_PER_DAY`) | 40 × 30 = **1.200** |
| Resúmenes horarios | máx. 24 al día, **solo si hay noticias** (sin noticias no se llama a Claude) | 24 × 30 = **720** |
| `/analizar` y `/resumen actualizar` manuales | 15 al día (`MANUAL_ANALYSES_PER_DAY`) | 15 × 30 = **450** |
| **Total en el peor caso** | | **≈ 2.370** |

Lo normal será bastante menos (muchos días no se alcanza el tope y de madrugada hay pocas noticias). Estimación de tamaño por llamada: ~1.200 tokens de entrada y ~800 de salida por noticia. Peor caso diario ≈ 200.000 tokens → ese es el tope `DAILY_TOKEN_BUDGET`.

Cuenta de ejemplo: 1.200 análisis × 2.000 tokens ≈ 2,4 M tokens/mes solo en noticias. **Multiplica por el precio actual del modelo elegido** (página de precios de Anthropic) para saber tu techo mensual. Por defecto se usa el modelo pequeño `claude-haiku-5-5` (el más barato de la familia); puedes cambiarlo con `ANTHROPIC_MODEL`.

## Cómo se controla el gasto (ya implementado)

1. **Filtro previo sin IA:** solo se analizan titulares con palabras clave de Fed, inflación, empleo, bonos, índices, IA/chips, grandes tecnológicas, resultados o geopolítica (`MIN_RELEVANCE=3`). Lo irrelevante **nunca** llega a Claude.
2. **Deduplicación antes de gastar:** por URL y por titulares casi idénticos (similitud ≥ 70 %). Una noticia ya vista no se analiza dos veces, ni aunque GitHub ejecute el workflow doble.
3. **Antigüedad máxima** (`MAX_ITEM_AGE_HOURS=6`): no se analizan noticias viejas.
4. **Tope por ejecución** (`MAX_ANALYSES_PER_RUN=3`), **por día** (`MAX_ANALYSES_PER_DAY=40`) y **por tokens** (`DAILY_TOKEN_BUDGET=200000`). Al llegar al tope el bot **deja de llamar a Claude** hasta el día siguiente (hora de Madrid) y el resumen horario usa un modo sin IA.
5. **Texto limitado** (`MAX_INPUT_CHARS=1500`) por noticia.
6. **Comandos manuales limitados:** espera de 120 s por usuario y 15 al día.
7. **Sin reintentos de pago:** si Claude responde algo inválido, no se vuelve a llamar por esa noticia.
8. **Registro de consumo** en la tabla `claude_usage` y visible con `/estado`.
9. **Tu freno definitivo:** el límite de gasto mensual en la consola de Anthropic (Paso 3 del README). Hazlo.

Para gastar menos: baja `MAX_ANALYSES_PER_DAY` a 15–20, pon `POST_LOW_IMPACT=false` o `MIN_RELEVANCE=4`.

## Frecuencia real

GitHub Actions programa tareas "cada 5 minutos", pero **no garantiza la hora exacta**: en horas de mucha carga puede retrasar 5–15 minutos o saltarse alguna ejecución. No esperes alertas al segundo; la alerta "30 minutos antes" puede llegar con algunos minutos de margen. Para un aviso exacto necesitarías un servidor propio (de pago).

## Otros límites a vigilar
* GitHub desactiva programadores de repos sin actividad 60 días.
* Vercel Hobby: funciones de hasta 60 s (el proyecto está configurado así) y cuotas mensuales.
* Si cambias a repo privado, vigila los minutos de Actions.
