-- Ejecutar una sola vez, DESPUES de crear la cuenta "nahuellegui12" desde la app.
-- Cerrar la app antes de ejecutar y volver a abrirla al finalizar.
-- Este script no modifica ni almacena la contraseña.

do $$
declare
  target_user_id uuid;
  migrated_meals jsonb;
begin
  select id
  into target_user_id
  from public.user_profiles
  where username = 'nahuellegui12';

  if target_user_id is null then
    raise exception 'Primero crea la cuenta nahuellegui12 desde FitTrack.';
  end if;

  update public.meals
  set user_id = target_user_id
  where user_id is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'name', name,
        'mealType', meal_type,
        'protein', protein,
        'carbs', carbs,
        'fats', fats,
        'calories', calories,
        'createdAt', created_at
      )
      order by created_at desc
    ),
    '[]'::jsonb
  )
  into migrated_meals
  from public.meals
  where user_id = target_user_id;

  insert into public.user_app_states as app_state (user_id, state, updated_at)
  values (
    target_user_id,
    jsonb_build_object(
      'profile', null,
      'meals', migrated_meals,
      'weighIns', '[]'::jsonb,
      'frequentMeals', '[]'::jsonb
    ),
    now()
  )
  on conflict (user_id) do update
  set state = jsonb_set(app_state.state, '{meals}', migrated_meals, true),
      updated_at = now();
end;
$$;

select
  p.username,
  count(m.id) as comidas_asignadas
from public.user_profiles p
left join public.meals m on m.user_id = p.id
where p.username = 'nahuellegui12'
group by p.username;
