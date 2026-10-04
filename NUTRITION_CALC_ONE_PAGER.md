# FitTrack - Resumen Tecnico para Profesionales de Nutricion

Este documento resume, en formato breve, como FitTrack estima calorias/macros y como propone ajustes semanales.

## 1) Variables que utiliza

- Datos antropometricos: sexo, edad, peso, altura.
- Contexto de actividad: tipo de trabajo, pasos promedio/dia, entrenos/semana, duracion por sesion, intensidad de entrenamiento.
- Objetivo: deficit, mantenimiento o superavit.
- Ajuste acumulado: `calorieAdjustment` (derivado de recalibraciones aceptadas).
- Seguimiento: pesajes semanales y adherencia calorica por logs.
- Bandera de semana atipica: enfermedad, viaje, retencion marcada, cambios bruscos de pasos/rutina, etc.

## 2) Estimacion de gasto energetico

### BMR (Mifflin-St Jeor)
- Hombre: `10*kg + 6.25*cm - 5*edad + 5`
- Mujer: `10*kg + 6.25*cm - 5*edad - 161`

### Componente NEAT
- Base por trabajo: sedentario `1.20`, activo `1.30`, fisico `1.40`.
- Correccion por pasos (chica, para evitar doble conteo):
  - `<5000`: `-0.02`
  - `5000-10000`: `0`
  - `10001-14000`: `+0.02`
  - `>14000`: `+0.03`
- Ajuste legacy por actividad declarada (`low/medium/high`): `-0.02 / 0 / +0.02`.
- `NEAT_final` se limita con clamp (`1.15 - 1.52`).

### Componente entrenamiento (MET neto)
- MET por intensidad: baja `4.5`, media `6.0`, alta `8.0`.
- Formula por sesion (neta):
  - `kcal_sesion_netas = (MET - 1) * peso_kg * (duracion_min/60)`
- Promedio diario:
  - `kcal_entreno_netas_dia = (kcal_sesion_netas * entrenos_semana)/7`

### TDEE y calorias objetivo
- `TDEE = BMR * NEAT_final + kcal_entreno_netas_dia`
- Multiplicador por objetivo (default):
  - Deficit: `0.85`
  - Mantenimiento: `1.00`
  - Superavit: `1.08`
- `kcal_obj = TDEE * multiplicador + calorieAdjustment`
- Limites de seguridad: `1400 - 6000 kcal`.
- En v1 no se aplica TEF explicito (se absorbe por recalibracion semanal).

## 3) Distribucion de macros (logica de resolucion)

1. **Proteina objetivo (g/kg)**
   - Deficit `1.9`
   - Mantenimiento `1.7`
   - Superavit `1.6`
   - `advancedCut` en deficit: `2.2`
   - Clamp seguridad global: `1.4 - 2.4 g/kg`

2. **Grasa**
   - Target: `0.8 g/kg`
   - Minima fisiologica: `0.65 g/kg`

3. **Carbohidratos por resto**
   - `carbs = (kcal_obj - protein*4 - fat*9)/4`

4. **Piso funcional de carbohidratos**
   - Deficit: `1.8 g/kg`
   - Mantenimiento: `2.2 g/kg`
   - Superavit: `2.8 g/kg`

5. **Si carbs cae por debajo del piso**
   - Se fija carbs en piso funcional.
   - Se intenta mantener grasa target (nunca por debajo de grasa minima).
   - Si no alcanzan las kcal para sostener proteina + carbs piso + grasa, se incrementa `kcal_obj` minimamente.

## 4) Recalibracion semanal (sugerencia, no automatica)

### Condiciones para evaluar ajuste
- Minimo 2 semanas de pesajes.
- Diferencia temporal >= 14 dias.
- Adherencia calorica estimada >= 80%.
- No aplicar si alguna semana reciente esta marcada como atipica.

### Ritmos esperados por objetivo
- Deficit: `-0.75% a -0.25%` por semana.
- Mantenimiento: `-0.20% a +0.20%` por semana.
- Superavit: `+0.10% a +0.40%` por semana.

### Reglas de propuesta (kcal/dia)
- Deficit:
  - por debajo de ritmo esperado -> `-120`
  - caida excesiva (< -0.9%/sem) -> `+100`
- Superavit:
  - sin subida suficiente -> `+120`
  - subida excesiva (> +0.6%/sem) -> `-100`
- Mantenimiento:
  - por encima de rango -> `-100`
  - por debajo de rango -> `+100`

### Confirmacion por parte del usuario
- La app muestra popup con: motivo, cambio semanal observado, rango objetivo y ajuste propuesto.
- El usuario debe aceptar/cancelar.
- Solo si acepta se actualiza `calorieAdjustment`.

## 5) Consideraciones clinicas

- El calculo inicial es una **hipotesis**; la precision real surge del seguimiento y la recalibracion.
- Los pisos de carbohidratos son **funcionales** para adherencia/general fitness, no objetivo universal de rendimiento deportivo alto.
- La v1 no incorpora aun hambre/saciedad/energia/rendimiento como variables decisoras del ajuste (planeado para iteracion siguiente).
