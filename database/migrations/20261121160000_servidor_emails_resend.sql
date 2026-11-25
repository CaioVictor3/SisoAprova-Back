begin;

insert into comunicacao.workflows(tipo_evento,habilitado)
values
 ('EMAIL_VERIFICATION',true),
 ('WELCOME_EMAIL',true),
 ('PASSWORD_RESET',true),
 ('USER_INACTIVE',false),
 ('SUBSCRIPTION_EXPIRING',true)
on conflict(tipo_evento) do nothing;

create or replace function identidade.sincronizar_usuario_supabase_auth()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_pessoa jsonb; v_sub text; v_nome text;
begin
 v_nome:=coalesce(
  nullif(btrim((select nome_completo from public.usuarios where "idUsuario"=new.id)),''),
  nullif(btrim(new.raw_user_meta_data->'pessoa'->>'nome_completo'),''),
  nullif(btrim(new.raw_user_meta_data->>'full_name'),''),
  nullif(btrim(new.raw_user_meta_data->>'name'),''),
  nullif(btrim(split_part(coalesce(new.email,''),'@',1)),''),
  'Estudante'
 );
 if tg_op='INSERT' and not exists(select 1 from public.usuarios where "idUsuario"=new.id) then
  perform identidade.criar_conta(new.id,new.email,null,null,new.email_confirmed_at,jsonb_build_object('nome_completo',left(v_nome,200)),false);
  v_pessoa:=new.raw_user_meta_data->'pessoa';
  if jsonb_typeof(v_pessoa)='object' then
   v_sub:=current_setting('request.jwt.claim.sub',true);
   perform set_config('request.jwt.claim.sub',new.id::text,true);
   perform public.salvar_minha_pessoa(v_pessoa);
   perform set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
   insert into public.estudantes("idEstudante") values(new.id) on conflict do nothing;
  end if;
 end if;
 if new.email_confirmed_at is not null then
  update public.usuarios set estado_cadastro='ativo',atualizado_em=now()
   where "idUsuario"=new.id and estado_cadastro='verificacao_pendente';
  update identidade.contas set email_confirmado_em=new.email_confirmed_at,atualizado_em=now()
   where "idUsuario"=new.id;
  v_nome:=coalesce(
   nullif(btrim((select nome_completo from public.usuarios where "idUsuario"=new.id)),''),
   v_nome,
   'Estudante'
  );
  if length(btrim(coalesce(new.email,''))) between 3 and 254 then
   insert into comunicacao.emails_transacionais(
    "idEmailTransacional",tipo_evento,"idUsuario",email_destinatario,assunto,dados_template,maximo_tentativas,agendado_em,chave_idempotencia
   ) values(
    gen_random_uuid(),
    'WELCOME_EMAIL',
    case when exists(select 1 from public.usuarios where "idUsuario"=new.id) then new.id else null end,
    btrim(new.email),
    'Boas-vindas ao Siso Aprova',
    jsonb_build_object('nome',left(v_nome,200)),
    5,
    now(),
    'WELCOME_EMAIL/'||new.id::text
   ) on conflict(chave_idempotencia) do nothing;
  end if;
 end if;
 return new;
end $$;
revoke all on function identidade.sincronizar_usuario_supabase_auth() from public,anon,authenticated;

create or replace function comunicacao.operar_api(p_operacao text,p_dados jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_receber boolean; v_linhas integer;
 v_pagina integer; v_quantidade integer; v_resultado jsonb;
begin
 if v_uid is null or not exists(select 1 from public.usuarios where "idUsuario"=v_uid and estado_cadastro='ativo') then
  raise exception 'Autenticação necessária' using errcode='42501';
 end if;
 if p_operacao='obter_preferencia' then
  return to_jsonb(coalesce((select receber_inatividade from comunicacao.preferencias where "idUsuario"=v_uid),false));
 elsif p_operacao='salvar_preferencia' then
  v_receber:=(p_dados->>'receber')::boolean;
  if v_receber is null then raise exception 'Preferência inválida'; end if;
  insert into comunicacao.preferencias("idUsuario",receber_inatividade,atualizado_em)
  values(v_uid,v_receber,now()) on conflict("idUsuario") do update set receber_inatividade=excluded.receber_inatividade,atualizado_em=now();
  if not v_receber then update comunicacao.emails_transacionais set status='cancelado',identificador_processamento=null,expiracao_reserva_em=null
   where "idUsuario"=v_uid and tipo_evento='USER_INACTIVE' and status in ('pendente','processando'); end if;
  return 'true'::jsonb;
 end if;
 if not public.eh_administrador() then raise exception 'Acesso administrativo necessário' using errcode='42501'; end if;
 if p_operacao='fluxos' then
  return (select jsonb_agg(jsonb_build_object('tipoEvento',t.tipo,'habilitado',coalesce(w.habilitado,t.tipo<>'USER_INACTIVE'),'dataHoraAtualizacao',w.atualizado_em) order by t.ordem)
   from (values(1,'EMAIL_VERIFICATION'),(2,'WELCOME_EMAIL'),(3,'PASSWORD_RESET'),(4,'USER_INACTIVE'),(5,'SUBSCRIPTION_EXPIRING')) t(ordem,tipo)
   left join comunicacao.workflows w on w.tipo_evento=t.tipo);
 elsif p_operacao='salvar_fluxo' then
  if p_dados->>'tipo' not in ('EMAIL_VERIFICATION','WELCOME_EMAIL','PASSWORD_RESET','USER_INACTIVE','SUBSCRIPTION_EXPIRING') or p_dados->>'habilitado' is null then raise exception 'Fluxo inválido'; end if;
  insert into comunicacao.workflows(tipo_evento,habilitado,atualizado_em)
  values(p_dados->>'tipo',(p_dados->>'habilitado')::boolean,now()) on conflict(tipo_evento) do update set habilitado=excluded.habilitado,atualizado_em=now();
  return (select jsonb_build_object('tipoEvento',tipo_evento,'habilitado',habilitado,'dataHoraAtualizacao',atualizado_em) from comunicacao.workflows where tipo_evento=p_dados->>'tipo');
 elsif p_operacao='metricas' then
  return (select jsonb_build_object('pendentes',count(*) filter(where status='pendente'),'processando',count(*) filter(where status='processando'),'aceitos',count(*) filter(where status='aceito'),'entregues',count(*) filter(where status='entregue'),'falhas',count(*) filter(where status='falha'),'bounces',count(*) filter(where status='bounce')) from comunicacao.emails_transacionais);
 elsif p_operacao='historico' then
  v_pagina:=coalesce((p_dados->>'pagina')::integer,1); v_quantidade:=coalesce((p_dados->>'quantidade')::integer,20);
  if v_pagina not between 1 and 100000 or v_quantidade not between 1 and 100 then raise exception 'Paginação inválida'; end if;
  with filtrados as (
   select * from comunicacao.emails_transacionais
   where ((p_dados->>'idUsuario') is null or "idUsuario"=(p_dados->>'idUsuario')::uuid)
    and ((p_dados->>'tipoEvento') is null or tipo_evento=p_dados->>'tipoEvento')
    and ((p_dados->>'status') is null or status=p_dados->>'status')
    and ((p_dados->>'de') is null or criado_em>=(p_dados->>'de')::timestamptz)
    and ((p_dados->>'ate') is null or criado_em<=(p_dados->>'ate')::timestamptz)
  ), pagina as (
   select "idEmailTransacional","idUsuario",tipo_evento as "tipoEvento",email_destinatario as "emailDestinatario",status,
   quantidade_tentativas as "quantidadeTentativas",maximo_tentativas as "maximoTentativas",
   criado_em as "dataHoraCriacao",enviado_em as "dataHoraEnvio",entregue_em as "dataHoraEntrega",mensagem_erro as "codigoErro"
   from filtrados order by criado_em desc,"idEmailTransacional" desc limit v_quantidade offset (v_pagina-1)*v_quantidade
  ) select jsonb_build_object('itens',coalesce((select jsonb_agg(to_jsonb(p)) from pagina p),'[]'::jsonb),'total',(select count(*) from filtrados),'pagina',v_pagina) into v_resultado;
  return v_resultado;
 elsif p_operacao='reprocessar' then
  update comunicacao.emails_transacionais set status='pendente',quantidade_tentativas=0,proxima_tentativa_em=null,mensagem_erro=null,identificador_processamento=null,expiracao_reserva_em=null
  where "idEmailTransacional"=(p_dados->>'id')::uuid and status='falha' and tipo_evento in ('WELCOME_EMAIL','USER_INACTIVE','SUBSCRIPTION_EXPIRING')
  and id_mensagem_provedor is null and mensagem_erro ~ '^resend_http_4[0-9]{2}$' and mensagem_erro not in ('resend_http_408','resend_http_429');
  get diagnostics v_linhas=row_count;
  return to_jsonb(v_linhas=1);
 end if;
 raise exception 'Operação inválida';
end $$;
revoke all on function comunicacao.operar_api(text,jsonb),public.operar_comunicacao(text,jsonb) from public,anon;
grant usage on schema comunicacao to authenticated;
grant execute on function comunicacao.operar_api(text,jsonb),public.operar_comunicacao(text,jsonb) to authenticated;

create or replace function comunicacao.operar_worker(p_operacao text,p_dados jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_registro record; v_rows jsonb:='[]'::jsonb; v_linhas integer:=0;
begin
 if jsonb_typeof(p_dados)<>'object' then raise exception 'Parâmetros inválidos'; end if;
 case p_operacao
when 'enfileirarEmailsUsuariosInativos' then
insert into comunicacao.emails_transacionais
              ("idEmailTransacional",tipo_evento,"idUsuario",email_destinatario,assunto,dados_template,maximo_tentativas,chave_idempotencia,agendado_em)
            select gen_random_uuid(),'USER_INACTIVE',u."idUsuario",u.email,'Continue seus estudos — Siso Aprova',
                   jsonb_build_object('nome',u.nome_completo,'dias',d.dias),(p_dados->>'maximo')::integer,
                   'USER_INACTIVE/'||u."idUsuario"::text||'/'||extract(epoch from coalesce(u.ultimo_acesso_em,u.criado_em))::bigint||'/'||d.dias,
                   now()
            from public.usuarios u
            join comunicacao.preferencias p on p."idUsuario"=u."idUsuario" and p.receber_inatividade
            cross join lateral (
              select max(dia) as dias from unnest(array(select x::integer from jsonb_array_elements_text(p_dados->'dias') x)::int[]) dia
              where coalesce(u.ultimo_acesso_em,u.criado_em)<=now()-make_interval(days=>dia)
            ) d
            where u.tipo='estudante' and u.estado_cadastro='ativo'
              and d.dias is not null
              and u.email<>''
              and not exists (
                select 1 from comunicacao.emails_transacionais existente
                where existente.chave_idempotencia='USER_INACTIVE/'||u."idUsuario"::text||'/'||
                  extract(epoch from coalesce(u.ultimo_acesso_em,u.criado_em))::bigint||'/'||d.dias
              )
            order by coalesce(u.ultimo_acesso_em,u.criado_em) desc, d.dias
            limit (p_dados->>'limite')::integer
            on conflict(chave_idempotencia) do nothing;
get diagnostics v_linhas=row_count;
when 'encerrarReservasExpiradas' then
update comunicacao.emails_transacionais
            set status='falha',mensagem_erro='maximo_tentativas',link_protegido=null,identificador_processamento=null,expiracao_reserva_em=null
            where status='processando' and expiracao_reserva_em<now() and quantidade_tentativas>=maximo_tentativas;
get diagnostics v_linhas=row_count;
when 'reservarLoteEmailsPendentes' then
for v_registro in with reservados as (
              select "idEmailTransacional" from comunicacao.emails_transacionais
              where tipo_evento=any(array(select x from jsonb_array_elements_text(p_dados->'tipos') x)) and ((status='pendente' and agendado_em<=now() and (proxima_tentativa_em is null or proxima_tentativa_em<=now()))
                 or (status='processando' and expiracao_reserva_em<now()))
                and quantidade_tentativas<maximo_tentativas
              order by coalesce(proxima_tentativa_em,agendado_em),criado_em
              for update skip locked limit (p_dados->>'limite')::integer
            )
            update comunicacao.emails_transacionais e
            set status='processando',quantidade_tentativas=e.quantidade_tentativas+1,
                ultima_tentativa_em=now(),identificador_processamento=(p_dados->>'reserva')::uuid,
                expiracao_reserva_em=now()+make_interval(secs=>(p_dados->>'segundos')::integer)
            from reservados r where e."idEmailTransacional"=r."idEmailTransacional"
            returning e."idEmailTransacional",e.tipo_evento,e."idUsuario",e.email_destinatario,e.assunto,
                      e.dados_template::text,e.link_protegido,e.validade_link_em,e.quantidade_tentativas,
                      e.maximo_tentativas,e.chave_idempotencia,e.identificador_processamento loop v_rows:=v_rows||jsonb_build_array(to_jsonb(v_registro)); end loop;
v_linhas:=jsonb_array_length(v_rows);
when 'consultarReservaEmail' then
for v_registro in select exists(select 1 from comunicacao.emails_transacionais where "idEmailTransacional"=(p_dados->>'id')::uuid and status='processando' and identificador_processamento=(p_dados->>'reserva')::uuid and expiracao_reserva_em>now()) loop v_rows:=v_rows||jsonb_build_array(to_jsonb(v_registro)); end loop;
v_linhas:=jsonb_array_length(v_rows);
when 'consultarPreferenciaInatividade' then
for v_registro in select exists(
                  select 1 from comunicacao.emails_transacionais e
                  join comunicacao.preferencias p on p."idUsuario"=e."idUsuario" and p.receber_inatividade
                  join public.usuarios u on u."idUsuario"=e."idUsuario"
                  where e."idEmailTransacional"=(p_dados->>'email')::uuid and e."idUsuario"=(p_dados->>'id')::uuid
                    and u.estado_cadastro='ativo' and u.email=e.email_destinatario
                    and coalesce(u.ultimo_acesso_em,u.criado_em)<=now()-
                      make_interval(days=>(e.dados_template->>'dias')::int)
                ) loop v_rows:=v_rows||jsonb_build_array(to_jsonb(v_registro)); end loop;
v_linhas:=jsonb_array_length(v_rows);
when 'validarElegibilidadeEnvioEmail' then
for v_registro in select exists(select 1 from identidade.tokens_email where token_hash=(p_dados->>'hash')::text and "idUsuario"=(p_dados->>'id')::uuid and finalidade=(p_dados->>'finalidade')::text and usado_em is null and expira_em>now()) loop v_rows:=v_rows||jsonb_build_array(to_jsonb(v_registro)); end loop;
v_linhas:=jsonb_array_length(v_rows);
when 'marcarEmailAceitoProvedor' then
update comunicacao.emails_transacionais set status='aceito',enviado_em=now(),id_mensagem_provedor=(p_dados->>'provedor')::text,link_protegido=null,identificador_processamento=null,expiracao_reserva_em=null,mensagem_erro=null where "idEmailTransacional"=(p_dados->>'id')::uuid and identificador_processamento=(p_dados->>'reserva')::uuid and status='processando';
get diagnostics v_linhas=row_count;
when 'marcarFalhaProcessamentoEmail' then
update comunicacao.emails_transacionais set status=(p_dados->>'status')::text,proxima_tentativa_em=(p_dados->>'proxima')::timestamptz,mensagem_erro=(p_dados->>'erro')::text,link_protegido=case when (p_dados->>'definitiva')::boolean then null else link_protegido end,identificador_processamento=null,expiracao_reserva_em=null where "idEmailTransacional"=(p_dados->>'id')::uuid and identificador_processamento=(p_dados->>'reserva')::uuid and status='processando';
get diagnostics v_linhas=row_count;
when 'cancelarEmailTransacional' then
update comunicacao.emails_transacionais set status='cancelado',mensagem_erro=(p_dados->>'motivo')::text,link_protegido=null,identificador_processamento=null,expiracao_reserva_em=null where "idEmailTransacional"=(p_dados->>'id')::uuid and identificador_processamento=(p_dados->>'reserva')::uuid and status='processando';
get diagnostics v_linhas=row_count;
when 'devolverEmailAguardandoAtivacao' then
update comunicacao.emails_transacionais
            set status='pendente',quantidade_tentativas=greatest(0,quantidade_tentativas-1),
                identificador_processamento=null,expiracao_reserva_em=null
            where "idEmailTransacional"=(p_dados->>'id')::uuid and identificador_processamento=(p_dados->>'reserva')::uuid and status='processando';
get diagnostics v_linhas=row_count;
when 'registrarEventoProvedorEmail' then
insert into comunicacao.eventos_resend(id_evento_webhook,id_mensagem_provedor,tipo_evento) values((p_dados->>'webhook')::text,(p_dados->>'id')::text,(p_dados->>'evento')::text) on conflict(id_evento_webhook) do nothing;
get diagnostics v_linhas=row_count;
when 'aplicarEventosRecebidosEmail' then
update comunicacao.emails_transacionais e
            set status=case
                  when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'id')::text and r.tipo_evento in ('email.bounced','email.complained','email.failed')) then 'bounce'
                  when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'id')::text and r.tipo_evento='email.delivered') then 'entregue'
                  else e.status end,
                entregue_em=case when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'id')::text and r.tipo_evento='email.delivered') then coalesce(e.entregue_em,now()) else e.entregue_em end
            where e.id_mensagem_provedor=(p_dados->>'id')::text and e.status in ('aceito','entregue','bounce');
get diagnostics v_linhas=row_count;
when 'limparHistoricoEmailsAntigos' then
with antigos as (
              select "idEmailTransacional" from comunicacao.emails_transacionais
              where criado_em<now()-make_interval(days=>(p_dados->>'dias')::integer)
                and status in ('aceito','entregue','falha','bounce','cancelado')
              order by criado_em limit 500
            )
            delete from comunicacao.emails_transacionais e using antigos a
            where e."idEmailTransacional"=a."idEmailTransacional";
get diagnostics v_linhas=row_count;
when 'limparEventosEmailAntigos' then
with antigos as (
              select id_evento_webhook from comunicacao.eventos_resend
              where recebido_em<now()-make_interval(days=>(p_dados->>'dias')::integer)
              order by recebido_em limit 500
            )
            delete from comunicacao.eventos_resend e using antigos a
            where e.id_evento_webhook=a.id_evento_webhook;
get diagnostics v_linhas=row_count;
when 'reprocessarEmailFalho' then
update comunicacao.emails_transacionais
            set status='pendente',quantidade_tentativas=0,proxima_tentativa_em=null,mensagem_erro=null,
                identificador_processamento=null,expiracao_reserva_em=null
            where "idEmailTransacional"=(p_dados->>'id')::uuid and status='falha'
              and tipo_evento in ('WELCOME_EMAIL','USER_INACTIVE','SUBSCRIPTION_EXPIRING')
              and id_mensagem_provedor is null and mensagem_erro ~ '^resend_http_4[0-9]{2}$'
              and mensagem_erro not in ('resend_http_408','resend_http_429');
get diagnostics v_linhas=row_count;
when 'listarFluxos' then
 for v_registro in select tipo_evento,habilitado,atualizado_em from comunicacao.workflows loop v_rows:=v_rows||jsonb_build_array(to_jsonb(v_registro)); end loop;
 v_linhas:=jsonb_array_length(v_rows);
when 'confirmarEnvio' then
 update comunicacao.emails_transacionais set status='aceito',enviado_em=now(),id_mensagem_provedor=(p_dados->>'provedor')::text,link_protegido=null,identificador_processamento=null,expiracao_reserva_em=null,mensagem_erro=null where "idEmailTransacional"=(p_dados->>'id')::uuid and identificador_processamento=(p_dados->>'reserva')::uuid and status='processando';
 get diagnostics v_linhas=row_count;
 if v_linhas=1 then
 update comunicacao.emails_transacionais e
            set status=case
                  when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'provedor')::text and r.tipo_evento in ('email.bounced','email.complained','email.failed')) then 'bounce'
                  when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'provedor')::text and r.tipo_evento='email.delivered') then 'entregue'
                  else e.status end,
                entregue_em=case when exists(select 1 from comunicacao.eventos_resend r where r.id_mensagem_provedor=(p_dados->>'provedor')::text and r.tipo_evento='email.delivered') then coalesce(e.entregue_em,now()) else e.entregue_em end
            where e.id_mensagem_provedor=(p_dados->>'provedor')::text and e.status in ('aceito','entregue','bounce');
 end if;
else raise exception 'Operação do worker não permitida' using errcode='42501';
end case;
return jsonb_build_object('rows',v_rows,'rowCount',v_linhas);
end $$;
revoke all on function comunicacao.operar_worker(text,jsonb),public.operar_worker_email(text,jsonb) from public,anon,authenticated;
grant usage on schema comunicacao to service_role;
grant execute on function comunicacao.operar_worker(text,jsonb),public.operar_worker_email(text,jsonb) to service_role;

create or replace function financeiro.operar_backend_legacy(p_operacao text,p_dados jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
 v_pessoa uuid; v_admin uuid; v_pedido public.pedidos_pagamento; v_plano public.planos_comerciais;
 v_ass public.assinaturas; v_pag public.pagamentos; v_json jsonb; v_inicio timestamptz; v_fim timestamptz;
 v_status text; v_reserva uuid; v_versao timestamptz; v_count integer; v_row record; v_dias integer;
begin
 v_pessoa:=nullif(p_dados->>'pessoa','')::uuid;
 v_admin:=nullif(p_dados->>'administrador','')::uuid;
 if v_admin is not null and not exists(select 1 from public.usuarios where "idUsuario"=v_admin and tipo='administrador' and estado_cadastro='ativo') then
  raise exception 'Administrador indisponível' using errcode='42501';
 end if;
 case p_operacao
 when 'limitar_requisicao' then
  insert into financeiro.limites_requisicoes(chave,minuto,quantidade) values(p_dados->>'chave',date_trunc('minute',now()),1)
   on conflict(chave,minuto) do update set quantidade=limites_requisicoes.quantidade+1 returning quantidade into v_count;
  if v_count>least((p_dados->>'limite')::integer,30) then raise exception 'Muitas solicitações financeiras. Aguarde um minuto.' using errcode='P0429'; end if;
  return 'true'::jsonb;
 when 'criar_pedido' then
  if p_dados->>'ambiente'<>(select ambiente from financeiro.configuracao) then raise exception 'Ambiente financeiro do banco e da API não correspondem'; end if;
  if not exists(select 1 from public.usuarios where "idUsuario"=v_pessoa and tipo='estudante' and estado_cadastro='ativo' and cadastro_completo) then raise exception 'Cadastro de estudante incompleto' using errcode='42501'; end if;
  -- Lock the existing identity row to serialize all checkouts and renewals for one student.
  perform 1 from public.pessoas where "idPessoa"=v_pessoa for update;
  select * into v_pedido from public.pedidos_pagamento where chave_idempotencia=(p_dados->>'chave')::uuid;
  if found then
   if v_pedido.id_pessoa<>v_pessoa or v_pedido.id_plano<>(p_dados->>'plano')::uuid or v_pedido.ambiente<>p_dados->>'ambiente' then raise exception 'Chave de idempotência já utilizada'; end if;
   return financeiro.json_pedido(v_pedido);
  end if;
  select * into v_pedido from public.pedidos_pagamento where id_pessoa=v_pessoa and id_plano=(p_dados->>'plano')::uuid and ambiente=p_dados->>'ambiente' and status in ('pendente','processando');
  if found then return financeiro.json_pedido(v_pedido); end if;
  select * into v_plano from public.planos_comerciais where id=(p_dados->>'plano')::uuid and ativo for share;
  if not found then raise exception 'Plano indisponível'; end if;
  insert into public.pedidos_pagamento(id_pessoa,id_plano,plano_nome,duracao_meses,beneficios,valor,moeda,ambiente,chave_idempotencia,referencia_externa)
  values(v_pessoa,v_plano.id,v_plano.nome,v_plano.duracao_meses,v_plano.beneficios,v_plano.valor,v_plano.moeda,p_dados->>'ambiente',(p_dados->>'chave')::uuid,gen_random_uuid()::text) returning * into v_pedido;
  insert into public.assinaturas(id_pessoa,id_pedido,id_plano,plano_nome,valor,duracao_meses,beneficios) values(v_pessoa,v_pedido.id,v_plano.id,v_plano.nome,v_plano.valor,v_plano.duracao_meses,v_plano.beneficios) returning * into v_ass;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) values(v_pessoa,v_ass.id,'assinatura_criada',v_pedido.id::text||':criada');
  return financeiro.json_pedido(v_pedido);
 when 'pedido' then
  select * into v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  if not found then raise exception 'Pedido não encontrado'; end if;
  return financeiro.json_pedido(v_pedido);
 when 'pedido_order' then
  select * into v_pedido from public.pedidos_pagamento where id_order_mp=p_dados->>'order';
  if not found then return null; end if;
  return financeiro.json_pedido(v_pedido);
 when 'reservar_checkout' then
  v_reserva:=gen_random_uuid();
  update public.pedidos_pagamento set reserva=v_reserva,reserva_ate=now()+interval '45 seconds',
   checkout_payload=coalesce(checkout_payload,p_dados->'payload')
   where id=(p_dados->>'id')::uuid and id_order_mp is null and (reserva_ate is null or reserva_ate<now()) returning * into v_pedido;
  if not found then return null; end if;
  return jsonb_build_object('reserva',v_reserva,'payload',v_pedido.checkout_payload);
 when 'salvar_checkout' then
  update public.pedidos_pagamento set id_order_mp=p_dados->>'order',checkout_url=p_dados->>'url',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and (id_order_mp is null or id_order_mp=p_dados->>'order') returning * into v_pedido;
  if not found then raise exception 'Reserva do checkout indisponível'; end if;
  return financeiro.json_pedido(v_pedido);
 when 'liberar_checkout' then
  update public.pedidos_pagamento set reserva=null,reserva_ate=null where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid;
  return 'true'::jsonb;
 when 'receber_webhook' then
  insert into financeiro.webhooks(chave,recurso,provedor,ambiente) values(p_dados->>'chave',p_dados->>'order',coalesce(p_dados->>'provedor','orders'),coalesce(p_dados->>'ambiente',(select ambiente from financeiro.configuracao))) on conflict do nothing;
  return 'true'::jsonb;
 when 'reservar_eventos' then
  update financeiro.webhooks set status='falha',erro='reserva_expirada_limite_tentativas',reserva=null,reserva_ate=null where status='processando' and tentativas>=12 and reserva_ate<now();
  with fila as (
   select chave from financeiro.webhooks where tentativas<12 and proxima_tentativa_em<=now()
   and (status='pendente' or (status='processando' and reserva_ate<now())) order by proxima_tentativa_em for update skip locked limit least(coalesce((p_dados->>'limite')::integer,10),50)
  ), reservados as (update financeiro.webhooks w set status='processando',tentativas=tentativas+1,reserva=gen_random_uuid(),reserva_ate=now()+interval '90 seconds' from fila where w.chave=fila.chave returning w.*) select coalesce(jsonb_agg(to_jsonb(reservados)),'[]'::jsonb) into v_json from reservados;
  return v_json;
 when 'concluir_evento' then
  update financeiro.webhooks set status=case when p_dados->>'erro' is null then 'processado' when tentativas>=12 then 'falha' else 'pendente' end,
   processado_em=case when p_dados->>'erro' is null then now() end, erro=p_dados->>'erro',reserva=null,reserva_ate=null,
   proxima_tentativa_em=now()+make_interval(secs=>least(3600,30*power(2,least(tentativas,7))::integer))
   where chave=p_dados->>'chave' and reserva=(p_dados->>'reserva')::uuid;
  return 'true'::jsonb;
 when 'aplicar_order' then
  select id_pessoa into v_pessoa from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  perform 1 from public.pessoas where "idPessoa"=v_pessoa for update;
  select * into strict v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  v_status:=p_dados->>'status'; v_versao:=(p_dados->>'versao')::timestamptz;
  if v_pedido.id_order_mp<>p_dados->>'order' or v_pedido.valor<>(p_dados->>'valor')::numeric or v_pedido.moeda<>p_dados->>'moeda' then raise exception 'Order divergente'; end if;
  if v_pedido.ultima_versao_mp>v_versao then return financeiro.json_pedido(v_pedido); end if;
  if v_pedido.ultima_versao_mp=v_versao and v_pedido.status<>v_status then raise exception 'Conflito de versão financeira'; end if;
  -- Terminal reversals are never undone by a delayed approved notification.
  if v_pedido.status in ('estornado','contestado') and v_status not in ('estornado','contestado') then return financeiro.json_pedido(v_pedido); end if;
  update public.pedidos_pagamento set status=v_status,ultima_versao_mp=v_versao,consultado_em=now(),atualizado_em=now(),
   webhook_confirmado=webhook_confirmado or coalesce((p_dados->>'webhook')::boolean,false) where id=v_pedido.id returning * into v_pedido;
  insert into public.pagamentos(id_pedido,id_pessoa,id_plano,id_order_mp,id_pagamento_mp,referencia_pagamento_mp,valor,moeda,status,metodo,parcelas,valor_estornado,detalhe_status,aprovado_em)
   values(v_pedido.id,v_pessoa,v_pedido.id_plano,v_pedido.id_order_mp,p_dados->>'pagamento',p_dados->>'referencia_pagamento',v_pedido.valor,v_pedido.moeda,v_status,p_dados->>'metodo',(p_dados->>'parcelas')::integer,coalesce((p_dados->>'estornado')::numeric,0),p_dados->>'detalhe',case when v_status='aprovado' then now() end)
   on conflict(id_pedido) do update set status=excluded.status,id_pagamento_mp=coalesce(excluded.id_pagamento_mp,pagamentos.id_pagamento_mp),referencia_pagamento_mp=coalesce(excluded.referencia_pagamento_mp,pagamentos.referencia_pagamento_mp),metodo=excluded.metodo,parcelas=excluded.parcelas,valor_estornado=excluded.valor_estornado,detalhe_status=excluded.detalhe_status,aprovado_em=coalesce(pagamentos.aprovado_em,excluded.aprovado_em),atualizado_em=now() returning * into v_pag;
  select * into strict v_ass from public.assinaturas where id_pedido=v_pedido.id for update;
  update public.assinaturas set id_pagamento=v_pag.id where id=v_ass.id;
  if v_status='aprovado' and v_ass.inicio_em is null and v_pedido.webhook_confirmado then
   select greatest(now(),coalesce(max(fim_em),now())) into v_inicio from public.assinaturas where id_pessoa=v_pessoa and status='ativa';
   v_fim:=((v_inicio at time zone 'UTC')+make_interval(months=>v_pedido.duracao_meses)) at time zone 'UTC';
   update public.assinaturas set status='ativa',inicio_em=v_inicio,fim_em=v_fim,atualizado_em=now() where id=v_ass.id;
   insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
    values(v_pessoa,v_ass.id,case when v_inicio>now() then 'renovacao' else 'ativacao' end,jsonb_build_object('inicio',v_inicio,'fim',v_fim,'pagamento',v_pag.id),v_pedido.id::text||':ativada') on conflict do nothing;
  elsif v_status in ('estornado','contestado','cancelado','rejeitado') then
   update public.assinaturas set status=case when v_status='contestado' then 'suspensa' else 'cancelada' end,
    cancelamento_em=case when v_status<>'contestado' then coalesce(cancelamento_em,now()) end,atualizado_em=now() where id=v_ass.id;
  end if;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
   values(v_pessoa,v_ass.id,'pagamento_'||v_status,jsonb_build_object('detalhe',p_dados->>'detalhe','order',v_pedido.id_order_mp),v_pedido.id::text||':'||v_status||':'||v_versao::text) on conflict do nothing;
  return financeiro.json_pedido(v_pedido);
 when 'conciliar' then
  return coalesce((select jsonb_agg(financeiro.json_pedido(p)) from (
   select * from public.pedidos_pagamento where (id_order_mp is not null or checkout_payload is not null) and criado_em>now()-interval '400 days'
    and (consultado_em is null or consultado_em<now()-interval '15 minutes')
    order by consultado_em nulls first,criado_em limit least(coalesce((p_dados->>'limite')::integer,10),50)
  ) p),'[]'::jsonb);
 when 'limitar_sincronizacao' then
  update public.pedidos_pagamento set consultado_em=now() where id=(p_dados->>'id')::uuid and (consultado_em is null or consultado_em<now()-interval '10 seconds');
  if not found then raise exception 'Aguarde alguns segundos antes de consultar novamente' using errcode='P0429'; end if;
  return 'true'::jsonb;
 when 'solicitar_cancelamento' then
  select * into strict v_ass from public.assinaturas where id=(p_dados->>'id')::uuid and id_pessoa=v_pessoa;
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,dados,chave)
   values(v_pessoa,v_ass.id,'cancelamento_solicitado',jsonb_build_object('justificativa',p_dados->>'justificativa'),v_ass.id::text||':cancelamento_solicitado') on conflict do nothing;
  return jsonb_build_object('recebido',true,'mensagem','Solicitação registrada para análise pelo suporte. Seu período pago permanece disponível até a análise; não há cobrança automática.');
 when 'painel' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  return jsonb_build_object(
   'ambiente',(select ambiente from financeiro.configuracao),
   'planos',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('valor',p.valor::text) order by p.ordem),'[]') from public.planos_comerciais p),
   'pagamentos',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('valor',p.valor::text,'valor_estornado',p.valor_estornado::text,'email',u.email)),'[]') from (
    select * from public.pagamentos p where (v_pessoa is null or p.id_pessoa=v_pessoa)
     and (nullif(p_dados->>'plano','') is null or p.id_plano=(p_dados->>'plano')::uuid)
     and (nullif(p_dados->>'status','') is null or p.status=p_dados->>'status')
     and (nullif(p_dados->>'de','') is null or p.criado_em>=(p_dados->>'de')::timestamptz)
     and (nullif(p_dados->>'ate','') is null or p.criado_em<(p_dados->>'ate')::timestamptz+interval '1 day')
     order by p.criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30
   ) p join public.usuarios u on u."idUsuario"=p.id_pessoa),
   'assinaturas',(select coalesce(jsonb_agg(to_jsonb(a)||jsonb_build_object('valor',a.valor::text,'email',u.email)),'[]') from (
    select * from public.assinaturas a where (v_pessoa is null or a.id_pessoa=v_pessoa)
     and (nullif(p_dados->>'plano','') is null or a.id_plano=(p_dados->>'plano')::uuid)
     and (nullif(p_dados->>'status','') is null or a.status=p_dados->>'status')
     and (nullif(p_dados->>'vencimento','') is null or a.fim_em<(p_dados->>'vencimento')::timestamptz+interval '1 day')
     order by a.criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30
   ) a join public.usuarios u on u."idUsuario"=a.id_pessoa),
   'historico',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select * from public.historico_assinaturas where v_pessoa is null or id_pessoa=v_pessoa order by criado_em desc limit 50) h),
   'eventosFalhos',(select coalesce(jsonb_agg(to_jsonb(w)-'reserva'),'[]') from (select * from financeiro.webhooks where status='falha' order by recebido_em desc limit 30) w),
   'cancelamentos',(select coalesce(jsonb_agg(to_jsonb(h)),'[]') from (select * from public.historico_assinaturas where tipo='cancelamento_solicitado' order by criado_em desc limit 30) h),
   'indicadores',(select jsonb_build_object(
    'bruto',coalesce(sum(valor) filter(where aprovado_em is not null),0)::text,
    'estornos',coalesce(sum(valor_estornado),0)::text,
    'contestado',coalesce(sum(valor) filter(where status='contestado'),0)::text,
    'liquidoEstimado',coalesce(sum(case when status='contestado' then 0 else valor-valor_estornado end) filter(where aprovado_em is not null),0)::text,
    'pendentes',count(*) filter(where status in ('pendente','processando')),
    'aprovados',count(*) filter(where status='aprovado'),'rejeitados',count(*) filter(where status='rejeitado'))
    from public.pagamentos where (nullif(p_dados->>'de','') is null or criado_em>=(p_dados->>'de')::timestamptz) and (nullif(p_dados->>'ate','') is null or criado_em<(p_dados->>'ate')::timestamptz+interval '1 day')),
   'ativos',(select count(distinct id_pessoa) from public.assinaturas where status='ativa' and inicio_em<=now() and fim_em>now()),
   'porPlano',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from (select plano_nome,count(*) quantidade from public.assinaturas where status='ativa' and inicio_em<=now() and fim_em>now() group by plano_nome) r),
   'vencendo',(select count(distinct id_pessoa) from public.assinaturas where status='ativa' and fim_em between now() and now()+interval '7 days' and not exists(select 1 from public.assinaturas b where b.id_pessoa=assinaturas.id_pessoa and b.status='ativa' and b.fim_em>assinaturas.fim_em)),
   'renovacoes',(select count(*) from public.historico_assinaturas where tipo='renovacao'),
   'pagina',coalesce((p_dados->>'pagina')::integer,1)
  );
 when 'marcar_consulta' then
  update public.pedidos_pagamento set consultado_em=now() where id=(p_dados->>'id')::uuid;
  return 'true'::jsonb;
 when 'manutencao' then
  update financeiro.webhooks set status='falha',erro='reserva_expirada_limite_tentativas',reserva=null,reserva_ate=null where status='processando' and tentativas>=12 and reserva_ate<now();
  delete from financeiro.limites_requisicoes where minuto<now()-interval '2 days';
  with expiradas as (update public.assinaturas set status='expirada',atualizado_em=now() where status='ativa' and fim_em<=now() returning *)
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) select id_pessoa,id,'expiracao',id::text||':expirada' from expiradas on conflict do nothing;
  for v_row in select a.* from public.assinaturas a where a.status in ('ativa','expirada') and a.fim_em between now()-interval '1 day' and now()+interval '8 days'
   and not exists(select 1 from public.assinaturas outra where outra.id_pessoa=a.id_pessoa and outra.status='ativa' and outra.fim_em>a.fim_em) loop
   v_dias:=greatest(0,ceil(extract(epoch from v_row.fim_em-now())/86400)::integer);
   if v_dias in (0,1,3,7) then
    insert into public.avisos_assinatura(id_pessoa,id_assinatura,dias,fim_em,mensagem)
    values(v_row.id_pessoa,v_row.id,v_dias,v_row.fim_em,case when v_dias=0 then 'Seu Premium venceu. Escolha um plano para renovar.' else 'Seu Premium vence em '||v_dias||' dia(s). A renovação é manual.' end) on conflict do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then
     insert into comunicacao.emails_transacionais("idEmailTransacional",tipo_evento,"idUsuario",email_destinatario,assunto,dados_template,maximo_tentativas,agendado_em,chave_idempotencia)
     select gen_random_uuid(),'SUBSCRIPTION_EXPIRING',u."idUsuario",u.email,'Sua assinatura Siso Aprova',jsonb_build_object('nome',coalesce(nullif(btrim(u.nome_completo),''),'Estudante')),5,now(),'assinatura:'||v_row.id||':'||v_dias||':'||v_row.fim_em::text
     from public.usuarios u where u."idUsuario"=v_row.id_pessoa on conflict(chave_idempotencia) do nothing;
    end if;
   end if;
  end loop;
  return 'true'::jsonb;
 when 'salvar_plano' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  if nullif(p_dados->>'id','') is not null then select * into strict v_plano from public.planos_comerciais where id=(p_dados->>'id')::uuid for update; end if;
  insert into public.planos_comerciais(id,codigo,nome,descricao,valor,duracao_meses,beneficios,ordem,ativo,destaque)
   values(coalesce(v_plano.id,gen_random_uuid()),coalesce(v_plano.codigo,p_dados->>'codigo'),p_dados->>'nome',p_dados->>'descricao',(p_dados->>'valor')::numeric,(p_dados->>'duracao_meses')::integer,p_dados->'beneficios',(p_dados->>'ordem')::integer,(p_dados->>'ativo')::boolean,(p_dados->>'destaque')::boolean)
   on conflict(id) do update set nome=excluded.nome,descricao=excluded.descricao,valor=excluded.valor,duracao_meses=excluded.duracao_meses,beneficios=excluded.beneficios,ordem=excluded.ordem,ativo=excluded.ativo,destaque=excluded.destaque,atualizado_em=now() returning to_jsonb(planos_comerciais)||jsonb_build_object('valor',planos_comerciais.valor::text) into v_json;
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,'salvar_plano',v_json->>'id',jsonb_build_object('antes',to_jsonb(v_plano),'depois',v_json));
  return v_json;
 when 'auditar' then
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,p_dados->>'acao',p_dados->>'id',jsonb_build_object('justificativa',p_dados->>'justificativa','chave',p_dados->>'chave'));
  return 'true'::jsonb;
 when 'reprocessar_eventos' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  update financeiro.webhooks set status='pendente',tentativas=0,proxima_tentativa_em=now() where status='falha';
  insert into financeiro.auditoria(id_administrador,acao,recurso) values(v_admin,'reprocessar_webhooks','fila');
  return 'true'::jsonb;
 when 'operacao_financeira' then
  if v_admin is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  select * into strict v_pedido from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  if p_dados->>'acao'='estornar' and v_pedido.status<>'aprovado' then raise exception 'Somente pagamentos aprovados podem ser estornados'; end if;
  if p_dados->>'acao'='cancelar' and v_pedido.status not in ('pendente','processando') then raise exception 'Somente pedidos pendentes podem ser cancelados'; end if;
  insert into financeiro.auditoria(id_administrador,acao,recurso,dados) values(v_admin,p_dados->>'acao',v_pedido.id::text,jsonb_build_object('justificativa',p_dados->>'justificativa','chave',p_dados->>'chave'));
  return financeiro.json_pedido(v_pedido);
 else raise exception 'Operação financeira inválida';
 end case;
end $$;

create or replace function financeiro.operar_backend(p_operacao text,p_dados jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.pedidos_pagamento; pl public.planos_comerciais; pe uuid; ad uuid; r uuid; v jsonb; amb text; v_count integer; v_row record; v_dias integer;
begin
 pe:=nullif(p_dados->>'pessoa','')::uuid; ad:=nullif(p_dados->>'administrador','')::uuid;
 if ad is not null and not exists(select 1 from public.usuarios where "idUsuario"=ad and tipo='administrador' and estado_cadastro='ativo') then raise exception 'Administrador indisponível' using errcode='42501'; end if;
 case p_operacao
 when 'criar_pedido_payments' then
  if p_dados->>'ambiente' is distinct from (select ambiente from financeiro.configuracao) then raise exception 'Ambiente divergente'; end if;
  if not exists(select 1 from public.usuarios where "idUsuario"=pe and tipo='estudante' and estado_cadastro='ativo' and cadastro_completo) then raise exception 'Cadastro incompleto' using errcode='42501'; end if;
  perform 1 from public.pessoas where "idPessoa"=pe for update;
  select * into p from public.pedidos_pagamento where chave_idempotencia=(p_dados->>'chave')::uuid;
  if found then
   if p.id_pessoa<>pe or p.id_plano<>(p_dados->>'plano')::uuid or p.ambiente<>p_dados->>'ambiente' then raise exception 'Chave já utilizada' using errcode='23505'; end if;
   return financeiro.json_pedido(p);
  end if;
  if exists(select 1 from public.pedidos_pagamento where id_pessoa=pe and ambiente=p_dados->>'ambiente' and estado_checkout_mp in ('enviando','ambiguo')) then raise exception 'Conciliação pendente' using errcode='40001'; end if;
  select * into p from public.pedidos_pagamento where id_pessoa=pe and id_plano=(p_dados->>'plano')::uuid and ambiente=p_dados->>'ambiente' and status in ('pendente','processando');
  if found then return financeiro.json_pedido(p); end if;
  select * into pl from public.planos_comerciais where id=(p_dados->>'plano')::uuid and ativo for share;
  if not found then raise exception 'Plano indisponível'; end if;
  insert into public.pedidos_pagamento(id_pessoa,id_plano,plano_nome,duracao_meses,beneficios,valor,moeda,ambiente,chave_idempotencia,referencia_externa,provedor)
   values(pe,pl.id,pl.nome,pl.duracao_meses,pl.beneficios,pl.valor,pl.moeda,p_dados->>'ambiente',(p_dados->>'chave')::uuid,gen_random_uuid()::text,'payments') returning * into p;
  insert into public.assinaturas(id_pessoa,id_pedido,id_plano,plano_nome,valor,duracao_meses,beneficios) values(pe,p.id,pl.id,pl.nome,pl.valor,pl.duracao_meses,pl.beneficios);
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) select pe,a.id,'assinatura_criada',p.id::text||':criada' from public.assinaturas a where a.id_pedido=p.id;
  return financeiro.json_pedido(p);
 when 'reservar_payment' then
  r:=gen_random_uuid();
  update public.pedidos_pagamento set estado_checkout_mp='enviando',reserva=r,reserva_ate=now()+interval '90 seconds',atualizado_em=now()
   where id=(p_dados->>'id')::uuid and provedor='payments' and estado_checkout_mp='novo' and id_pagamento_mp is null returning * into p;
  if not found then return null; end if;
  return jsonb_build_object('reserva',r);
 when 'falhar_payment' then
  update public.pedidos_pagamento set estado_checkout_mp='concluido',status='rejeitado',status_pagamento_mp='rejected',detalhe_pagamento_mp='creation_rejected',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and id_pagamento_mp is null;
  update public.assinaturas set status='cancelada',cancelamento_em=coalesce(cancelamento_em,now()),atualizado_em=now()
   where id_pedido=(p_dados->>'id')::uuid and status='pendente';
  return 'true'::jsonb;
 when 'ambiguo_payment' then
  update public.pedidos_pagamento set estado_checkout_mp='ambiguo',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and reserva=(p_dados->>'reserva')::uuid and id_pagamento_mp is null;
  return 'true'::jsonb;
 when 'vincular_payment' then
  if p_dados->>'pagamento' !~ '^[0-9]{1,30}$' then raise exception 'Pagamento inválido'; end if;
  update public.pedidos_pagamento set id_pagamento_mp=p_dados->>'pagamento',estado_checkout_mp='concluido',reserva=null,reserva_ate=null,atualizado_em=now()
   where id=(p_dados->>'id')::uuid and provedor='payments' and (id_pagamento_mp is null or id_pagamento_mp=p_dados->>'pagamento') returning * into p;
  if not found then raise exception 'Pagamento divergente'; end if;
  return financeiro.json_pedido(p);
 when 'pedido_payment' then
  select * into p from public.pedidos_pagamento where provedor='payments' and id_pagamento_mp=p_dados->>'pagamento';
  if not found then return null; end if; return financeiro.json_pedido(p);
 when 'pedido_referencia' then
  select * into p from public.pedidos_pagamento where provedor='payments' and referencia_externa=p_dados->>'referencia';
  if not found then return null; end if; return financeiro.json_pedido(p);
 when 'aplicar_payment' then
  select * into p from public.pedidos_pagamento where id=(p_dados->>'id')::uuid;
  perform 1 from public.pessoas where "idPessoa"=p.id_pessoa for update;
  select * into strict p from public.pedidos_pagamento where id=(p_dados->>'id')::uuid for update;
  if p.provedor<>'payments' or p.id_pagamento_mp is distinct from p_dados->>'pagamento' then raise exception 'Pagamento divergente'; end if;
  if p.ultima_versao_mp>(p_dados->>'versao')::timestamptz then return financeiro.json_pedido(p); end if;
  if p.status in ('estornado','contestado') and p_dados->>'status' not in ('estornado','contestado') then return financeiro.json_pedido(p); end if;
  update public.pedidos_pagamento set status_pagamento_mp=p_dados->>'status_mp',detalhe_pagamento_mp=p_dados->>'detalhe' where id=p.id;
  v:=financeiro.operar_backend_legacy('aplicar_order',p_dados||jsonb_build_object('order',null));
  update public.pedidos_pagamento set consultado_em=p.consultado_em where id=p.id;
  return v;
 when 'aplicar_order' then
  if exists(select 1 from public.pedidos_pagamento where id=(p_dados->>'id')::uuid and provedor<>'orders') then raise exception 'Provedor divergente'; end if;
  return financeiro.operar_backend_legacy(p_operacao,p_dados);
 when 'conciliar' then
  return coalesce((select jsonb_agg(financeiro.json_pedido(q)) from (
   select * from public.pedidos_pagamento where criado_em>now()-interval '400 days'
    and (id_order_mp is not null or checkout_payload is not null or (provedor='payments' and (id_pagamento_mp is not null or estado_checkout_mp in ('enviando','ambiguo'))))
    and (consultado_em is null or consultado_em<now()-interval '15 minutes')
    order by consultado_em nulls first,criado_em limit least(coalesce((p_dados->>'limite')::integer,3),50)
  ) q),'[]'::jsonb);
 when 'painel' then
  if ad is null then raise exception 'Administrador obrigatório' using errcode='42501'; end if;
  amb:=coalesce(nullif(p_dados->>'ambiente',''),(select ambiente from financeiro.configuracao));
  if amb not in ('teste','producao') then raise exception 'Ambiente inválido'; end if;
  with filtrados as (
   select q.* from public.pedidos_pagamento q left join public.assinaturas a on a.id_pedido=q.id
   where q.ambiente=amb and (pe is null or q.id_pessoa=pe)
    and (nullif(p_dados->>'plano','') is null or q.id_plano=(p_dados->>'plano')::uuid)
    and (nullif(p_dados->>'status','') is null or q.status=p_dados->>'status')
    and (nullif(p_dados->>'de','') is null or q.criado_em>=(p_dados->>'de')::date)
    and (nullif(p_dados->>'ate','') is null or q.criado_em<(p_dados->>'ate')::date+interval '1 day')
    and (nullif(p_dados->>'vencimento','') is null or a.fim_em<(p_dados->>'vencimento')::date+interval '1 day')
  ), pag as (select x.* from public.pagamentos x join filtrados f on f.id=x.id_pedido),
  ass as (select a.* from public.assinaturas a join filtrados f on f.id=a.id_pedido),
  hist as (select h.* from public.historico_assinaturas h join ass a on a.id=h.id_assinatura)
  select jsonb_build_object(
   'ambiente',amb,'pagina',coalesce((p_dados->>'pagina')::integer,1),
   'planos',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text) order by x.ordem),'[]'::jsonb) from public.planos_comerciais x),
   'pagamentos',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text,'valor_estornado',x.valor_estornado::text,'email',u.email)),'[]'::jsonb) from (select * from pag order by criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30) x join public.usuarios u on u."idUsuario"=x.id_pessoa),
   'assinaturas',(select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('valor',x.valor::text,'email',u.email)),'[]'::jsonb) from (select * from ass order by criado_em desc limit 30 offset (coalesce((p_dados->>'pagina')::integer,1)-1)*30) x join public.usuarios u on u."idUsuario"=x.id_pessoa),
   'historico',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select * from hist order by criado_em desc limit 50) x),
   'cancelamentos',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select * from hist where tipo='cancelamento_solicitado' order by criado_em desc limit 30) x),
   'eventosFalhos',(select coalesce(jsonb_agg(to_jsonb(x)-'reserva'),'[]'::jsonb) from (select w.* from financeiro.webhooks w where w.ambiente=amb and w.status='falha' and ((pe is null and nullif(p_dados->>'plano','') is null and nullif(p_dados->>'status','') is null and nullif(p_dados->>'de','') is null and nullif(p_dados->>'ate','') is null and nullif(p_dados->>'vencimento','') is null) or exists(select 1 from filtrados f where (f.provedor=w.provedor and w.recurso=coalesce(f.id_pagamento_mp,f.id_order_mp)))) order by recebido_em desc limit 30) x),
   'aprovadosSemWebhook',(select coalesce(jsonb_agg(financeiro.json_pedido(x)),'[]'::jsonb) from (select * from filtrados where status='aprovado' and not webhook_confirmado order by criado_em desc limit 30) x),
   'checkoutsInconclusivos',(select coalesce(jsonb_agg(financeiro.json_pedido(x)),'[]'::jsonb) from (select * from filtrados where estado_checkout_mp in ('enviando','ambiguo') order by criado_em desc limit 30) x),
   'indicadores',(select jsonb_build_object('bruto',coalesce(sum(valor) filter(where aprovado_em is not null),0)::text,'estornos',coalesce(sum(valor_estornado),0)::text,'contestado',coalesce(sum(valor) filter(where status='contestado'),0)::text,'liquidoEstimado',coalesce(sum(case when status='contestado' then 0 else valor-valor_estornado end) filter(where aprovado_em is not null),0)::text,'pendentes',count(*) filter(where status in ('pendente','processando')),'aprovados',count(*) filter(where status='aprovado'),'rejeitados',count(*) filter(where status='rejeitado')) from pag),
   'ativos',(select count(distinct id_pessoa) from ass where status='ativa' and inicio_em<=now() and fim_em>now()),
   'porPlano',(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select plano_nome,count(*) quantidade from ass where status='ativa' and inicio_em<=now() and fim_em>now() group by plano_nome) x),
   'vencendo',(select count(distinct a.id_pessoa) from ass a where a.status='ativa' and a.fim_em between now() and now()+interval '7 days' and not exists(select 1 from ass b where b.id_pessoa=a.id_pessoa and b.status='ativa' and b.fim_em>a.fim_em)),
   'renovacoes',(select count(*) from hist where tipo='renovacao')
  ) into v; return v;
 when 'manutencao' then
  update financeiro.webhooks set status='falha',erro='reserva_expirada_limite_tentativas',reserva=null,reserva_ate=null where status='processando' and tentativas>=12 and reserva_ate<now();
  delete from financeiro.limites_requisicoes where minuto<now()-interval '2 days';
  with expiradas as (update public.assinaturas set status='expirada',atualizado_em=now() where status='ativa' and fim_em<=now() returning *)
  insert into public.historico_assinaturas(id_pessoa,id_assinatura,tipo,chave) select id_pessoa,id,'expiracao',id::text||':expirada' from expiradas on conflict do nothing;
  for v_row in select a.* from public.assinaturas a where a.status in ('ativa','expirada') and a.fim_em between now()-interval '1 day' and now()+interval '8 days'
   and not exists(select 1 from public.assinaturas outra where outra.id_pessoa=a.id_pessoa and outra.status='ativa' and outra.fim_em>a.fim_em) loop
   v_dias:=greatest(0,ceil(extract(epoch from v_row.fim_em-now())/86400)::integer);
   if v_dias in (0,1,3,7) then
    insert into public.avisos_assinatura(id_pessoa,id_assinatura,dias,fim_em,mensagem)
    values(v_row.id_pessoa,v_row.id,v_dias,v_row.fim_em,case when v_dias=0 then 'Seu Premium venceu. Escolha um plano para renovar.' else 'Seu Premium vence em '||v_dias||' dia(s). A renovação é manual.' end) on conflict do nothing;
    get diagnostics v_count=row_count;
    if v_count=1 then
     insert into comunicacao.emails_transacionais("idEmailTransacional",tipo_evento,"idUsuario",email_destinatario,assunto,dados_template,maximo_tentativas,agendado_em,chave_idempotencia)
     select gen_random_uuid(),'SUBSCRIPTION_EXPIRING',u."idUsuario",u.email,'Sua assinatura Siso Aprova',jsonb_build_object('nome',coalesce(nullif(btrim(u.nome_completo),''),'Estudante')),5,now(),'assinatura:'||v_row.id||':'||v_dias||':'||v_row.fim_em::text
     from public.usuarios u where u."idUsuario"=v_row.id_pessoa on conflict(chave_idempotencia) do nothing;
    end if;
   end if;
  end loop;
  return 'true'::jsonb;
 else return financeiro.operar_backend_legacy(p_operacao,p_dados);
 end case;
end $$;
revoke all on function financeiro.operar_backend_legacy(text,jsonb),financeiro.operar_backend(text,jsonb) from public,anon,authenticated,concursa_dados;
grant execute on function financeiro.operar_backend(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
