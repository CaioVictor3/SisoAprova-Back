begin;

create function provas_privado.importar_prova_json(
  p_idprova uuid, p_prova jsonb, p_questoes jsonb, p_aplicar boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := p_idprova;
  v_uf text := nullif(upper(btrim(p_prova->>'uf')), '');
  v_ano integer := (p_prova->>'ano')::integer;
  v_orgao text := btrim(p_prova->>'orgao');
  v_cargo text := btrim(coalesce(p_prova->>'cargo', ''));
  v_banca uuid := (p_prova->>'idOrganizadora')::uuid;
  v_confirmada boolean;
  v_questao jsonb;
  v_numero integer;
  v_nome_banca text := btrim(p_prova->>'organizadora');
  v_nova_banca text;
  v_novos_temas text[];
  v_id_tema uuid;
  v_id_questao uuid;
begin
  if not coalesce(public.eh_administrador(), false) then
    raise exception 'Acesso administrativo necessário' using errcode = '42501';
  end if;

  if p_aplicar is null or jsonb_typeof(p_questoes) is distinct from 'array' then
    raise exception 'Envie um lote de questões válido';
  end if;
  if jsonb_array_length(p_questoes) not between 1 and 250 then
    raise exception 'Informe entre 1 e 250 questões por arquivo';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_questoes) as q(dados)
    group by (dados->>'numero')::integer
    having (dados->>'numero')::integer is null or (dados->>'numero')::integer < 1 or count(*) > 1
  ) then
    raise exception 'Cada questão deve ter um número original positivo e único';
  end if;

  -- Serializa importações para que a resolução de nomes e a verificação de duplicidade usem o mesmo catálogo.
  if p_aplicar then
    perform pg_advisory_xact_lock(hashtextextended('provas_privado.importar_prova_json', 0));
  end if;

  if v_id is null then
    if v_banca is null and coalesce(length(v_nome_banca), 0) between 1 and 200 then
      if (select count(*) from public.bancas b where lower(btrim(b.nome)) = lower(v_nome_banca)) > 1 then
        raise exception 'Há mais de uma organizadora com esse nome. Selecione o registro no painel';
      end if;
      select b."idBanca" into v_banca
        from public.bancas b where lower(btrim(b.nome)) = lower(v_nome_banca);
      if v_banca is null then
        v_nova_banca := v_nome_banca;
      end if;
    end if;
    if v_ano is null or v_ano not between 1000 and 9999
      or coalesce(length(v_orgao), 0) not between 1 and 200 or length(v_cargo) > 200
      or (v_nova_banca is null and not exists (select 1 from public.bancas b where b."idBanca" = v_banca)) then
      raise exception 'Informe ano, órgão e organizadora do catálogo';
    end if;
    if exists (
      select 1 from public.concursos c where c.ano = v_ano
        and lower(btrim(c.orgao)) = lower(v_orgao)
        and lower(btrim(coalesce(c.cargo, ''))) = lower(v_cargo)
        and c."idOrganizadora" = v_banca
        and (c.uf is null or v_uf is null or c.uf = v_uf)
    ) then
      raise exception 'Já existe uma prova com esses metadados. Use o idProva para incluir novos números';
    end if;
  else
    if p_aplicar then
      perform 1 from public.concursos c where c."idConcurso" = v_id for update;
    end if;
    select c.composicao_confirmada, c."idOrganizadora" into v_confirmada, v_banca
      from public.concursos c where c."idConcurso" = v_id;
    if not found or v_banca is null then
      raise exception 'Selecione uma prova existente com organizadora cadastrada';
    end if;
    if v_confirmada then
      raise exception 'A composição desta prova já foi confirmada';
    end if;
    select min(q.numero) into v_numero
      from jsonb_array_elements(p_questoes) as entrada(dados)
      join public.questoes q on q."idConcurso" = v_id and q.numero = (dados->>'numero')::integer;
    if v_numero is not null then
      raise exception 'A questão % já está cadastrada nesta prova', v_numero;
    end if;
  end if;

  select min((dados->>'numero')::integer) into v_numero
    from jsonb_array_elements(p_questoes) as q(dados)
    where (
      (dados->>'idTema') is not null and not exists (
        select 1 from public.temas t where t."idTema" = (dados->>'idTema')::uuid
      )
    ) or (
      (dados->>'idTema') is null and coalesce(length(btrim(dados->>'tema')), 0) not between 1 and 200
    );
  if v_numero is not null then
    raise exception 'O tema da questão % não está no catálogo', v_numero;
  end if;

  select coalesce(array_agg(nome order by nome), '{}'::text[]) into v_novos_temas
    from (
      select min(btrim(dados->>'tema')) as nome
      from jsonb_array_elements(p_questoes) as q(dados)
      where (dados->>'idTema') is null and not exists (
        select 1 from public.temas t where lower(btrim(t.nome)) = lower(btrim(dados->>'tema'))
      )
      group by lower(btrim(dados->>'tema'))
    ) as novos;

  if p_aplicar then
    if v_nova_banca is not null then
      insert into public.bancas(nome) values (v_nova_banca) returning "idBanca" into v_banca;
    end if;
    insert into public.temas(nome)
      select unnest(v_novos_temas) on conflict do nothing;
    if v_id is null then
      v_id := public.salvar_prova(null, v_ano, v_orgao, v_banca, v_cargo, false, v_uf);
    end if;
    for v_questao in select value from jsonb_array_elements(p_questoes) loop
      v_id_tema := (v_questao->>'idTema')::uuid;
      if v_id_tema is null then
        select t."idTema" into v_id_tema from public.temas t
          where lower(btrim(t.nome)) = lower(btrim(v_questao->>'tema'));
      end if;
      v_id_questao := public.salvar_questao(
        (v_questao - 'alternativas' - 'gabarito') ||
          jsonb_build_object('idProva', v_id, 'idTema', v_id_tema, 'status', 'rascunho'),
        v_questao->'alternativas',
        v_questao->'gabarito'
      );
      if (v_questao #>> '{gabarito,fonte}') is not null then
        update public.gabaritos set fonte_gabarito = v_questao #>> '{gabarito,fonte}'
          where "idQuestao" = v_id_questao;
      end if;
    end loop;
  end if;
  return jsonb_build_object('idProva', v_id, 'novaOrganizadora', v_nova_banca, 'novosTemas', v_novos_temas);
end;
$$;

create function public.importar_prova_json(
  p_idprova uuid, p_prova jsonb, p_questoes jsonb, p_aplicar boolean
) returns jsonb
language sql security invoker set search_path = '' as $$
  select provas_privado.importar_prova_json(p_idprova, p_prova, p_questoes, p_aplicar);
$$;

revoke all on function provas_privado.importar_prova_json(uuid, jsonb, jsonb, boolean)
  from public, anon;
revoke all on function public.importar_prova_json(uuid, jsonb, jsonb, boolean)
  from public, anon;
grant execute on function provas_privado.importar_prova_json(uuid, jsonb, jsonb, boolean)
  to authenticated;
grant execute on function public.importar_prova_json(uuid, jsonb, jsonb, boolean)
  to authenticated;

commit;
