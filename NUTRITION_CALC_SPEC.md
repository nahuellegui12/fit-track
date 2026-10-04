# FitTrack - Especificacion de Calculo Nutricional y Recalibracion

## 1) Objetivo del motor
Este motor estima calorias y macros diarios (P/C/G) a partir del perfil del usuario y ajusta recomendaciones en el tiempo con base en evolucion de peso y adherencia.

---

## 2) Variables de entrada

### Perfil
- Sexo (`male` / `female`)
- Edad (anos)
- Peso (kg)
- Altura (cm)
- Objetivo (`deficit`, `maintenance`, `surplus`)
- Nivel de actividad (`low`, `medium`, `high`) *(legacy)*
- Tipo de trabajo (`sedentary`, `active`, `physical`)
- Pasos promedio por dia
- Entrenos por semana
- Duracion promedio por entreno (min)
- Intensidad de entrenamiento (`low`, `moderate`, `high`)
- Toggle `advancedCut` (solo deficit)
- Ajuste acumulado (`calorieAdjustment`)

### Seguimiento
- Pesajes semanales (fecha, peso)
- Marcador de semana atipica (`isAtypicalWeek`) + motivo opcional
- Registro de comidas (para adherencia calorica)

---

## 3) Calculo energetico (kcal)

### 3.1 BMR (Mifflin-St Jeor)
- Hombre: `BMR = 10*kg + 6.25*cm - 5*edad + 5`
- Mujer: `BMR = 10*kg + 6.25*cm - 5*edad - 161`

### 3.2 NEAT
Base por tipo de trabajo:
- Sedentario: `1.20`
- Activo: `1.30`
- Fisico: `1.40`

Correccion por pasos:
- `< 5000`: `-0.02`
- `5000 - 10000`: `0`
- `10001 - 14000`: `+0.02`
- `> 14000`: `+0.03`

Ajuste legacy por actividad declarada:
- `low`: `-0.02`
- `medium`: `0`
- `high`: `+0.02`

NEAT final:
- `NEAT_final = clamp(NEAT_base + corr_pasos + corr_actividad, 1.15, 1.52)`

### 3.3 Gasto neto por entrenamiento (MET neto)
- MET por intensidad:
  - low: `4.5`
  - moderate: `6.0`
  - high: `8.0`
- Formula neta por sesion:
  - `kcal_sesion_netas = (MET - 1) * peso_kg * (duracion_min/60)`
- Promedio diario:
  - `kcal_entreno_netas_dia = (kcal_sesion_netas * entrenos_semana) / 7`

### 3.4 TDEE
- `TDEE = BMR * NEAT_final + kcal_entreno_netas_dia`
- **Nota:** en v1 no se aplica TEF explicito.

### 3.5 Calorias objetivo por objetivo
- Deficit: `TDEE * 0.85` (default -15%)
- Mantenimiento: `TDEE * 1.00`
- Superavit: `TDEE * 1.08` (default +8%)

Calorias finales:
- `kcal_obj = kcal_obj + calorieAdjustment`
- `kcal_obj = clamp(kcal_obj, 1400, 6000)`

---

## 4) Calculo de macros (orden de resolucion exacto)

1. Calcular proteina objetivo (g/kg):
   - Deficit: `1.9 g/kg`
   - Deficit con `advancedCut`: `2.2 g/kg`
   - Mantenimiento: `1.7 g/kg`
   - Superavit: `1.6 g/kg`
   - Clamp seguridad: `1.4 - 2.4 g/kg`

2. Calcular grasa target y minima:
   - `fat_target = 0.8 g/kg`
   - `fat_min = 0.65 g/kg`
   - iniciar con `fat = max(fat_target, fat_min)`

3. Calcular carbohidratos por resto:
   - `carbs = (kcal_obj - protein*4 - fat*9)/4`

4. Aplicar piso funcional de carbohidratos:
   - Deficit: `>= 1.8 g/kg`
   - Mantenimiento: `>= 2.2 g/kg`
   - Superavit: `>= 2.8 g/kg`

5. Si `carbs < piso`:
   - fijar `carbs = piso`
   - intentar mantener `fat = fat_target` (nunca `< fat_min`)
   - si kcal no alcanza para `protein + carbs piso + fat`, subir `kcal_obj` minimamente

6. Resultado final:
   - Calorias y macros diarios (`protein`, `carbs`, `fats`)

---

## 5) Recalibracion automatica (sugerencia con confirmacion)

### 5.1 Condiciones minimas para sugerir ajuste
- Minimo 2 semanas de datos de peso
- Diferencia temporal >= 14 dias
- Adherencia calorica >= 80%
- No recalibrar si hay semana atipica reciente (`isAtypicalWeek = true`)

### 5.2 Metrica de cambio semanal
- `% semanal = ((peso_actual - peso_base) / peso_base) * 100 * 7 / dias_transcurridos`

### 5.3 Rangos esperados por objetivo
- Deficit: `-0.75% a -0.25% / semana`
- Mantenimiento: `-0.20% a +0.20% / semana`
- Superavit: `+0.10% a +0.40% / semana`

### 5.4 Reglas de ajuste sugerido
- Deficit:
  - Si no baja al ritmo esperado: `-120 kcal/dia`
  - Si baja demasiado rapido (< -0.9%): `+100 kcal/dia`
- Superavit:
  - Si no sube al ritmo esperado: `+120 kcal/dia`
  - Si sube demasiado rapido (> +0.6%): `-100 kcal/dia`
- Mantenimiento:
  - Si sube fuera de rango: `-100 kcal/dia`
  - Si baja fuera de rango: `+100 kcal/dia`

### 5.5 UX de confirmacion (popup)
Antes de aplicar ajuste, mostrar:
- Motivo del ajuste
- Cambio semanal detectado (%)
- Rango esperado (%)
- Propuesta de ajuste (kcal/dia)

Acciones:
- `Cancelar`
- `Aplicar`

Si aplica:
- Actualizar `calorieAdjustment`

---

## 6) Limitaciones actuales (v1)
- No usa aun senales subjetivas (hambre/saciedad, energia, rendimiento) en la regla final.
- No usa masa libre de grasa para proteina avanzada.
- No periodiza por disciplina deportiva (fuerza vs endurance) mas alla de intensidad general.

---

## 7) Nota clinica
El calculo inicial es una hipotesis cuantitativa. La precision real se obtiene con recalibracion iterativa segun evolucion de peso, adherencia y contexto semanal.
