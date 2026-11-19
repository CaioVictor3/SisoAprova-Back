"""Confere a correspondência entre o manifesto revisado e o JSON de importação."""
import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit


def exigir(condicao, mensagem):
    if not condicao:
        raise ValueError(mensagem)


def inteiro_positivo(valor):
    return type(valor) is int and valor > 0


def indexar(questoes, nome):
    exigir(isinstance(questoes, list) and questoes, f"{nome}: lista de questões vazia.")
    indice = {}
    for questao in questoes:
        numero = questao["numero"]
        exigir(inteiro_positivo(numero) and numero not in indice,
               f"{nome}: número inválido ou duplicado ({numero}).")
        indice[numero] = questao
    return indice


def conferir(manifesto, lote, pasta, pronto):
    numeros = manifesto["numerosCaderno"]
    exigir(isinstance(numeros, list) and numeros and all(map(inteiro_positivo, numeros))
           and len(set(numeros)) == len(numeros), "Confira a numeração original do caderno.")
    esperado = set(numeros)
    revisadas = indexar(manifesto["questoes"], "Manifesto")
    extraidas = indexar(lote["questoes"], "Lote")
    for nome, indice in [("Manifesto", revisadas), ("Lote", extraidas)]:
        faltam, sobram = esperado - indice.keys(), indice.keys() - esperado
        exigir(not faltam and not sobram,
               f"{nome}: números ausentes {sorted(faltam)} e excedentes {sorted(sobram)}.")
    exigir(not lote.get("pendenciasExtracao"), "Resolva as pendências de extração antes da carga.")

    imagens = 0
    for numero in sorted(esperado):
        revisada, questao = revisadas[numero], extraidas[numero]
        campo = f"Questão {numero}"
        exigir(all(inteiro_positivo(revisada[chave]) for chave in ("paginaCaderno", "paginaGabarito"))
               and revisada["secaoGabarito"].strip(), f"{campo}: referência de origem incompleta.")
        letras = [alternativa["letra"] for alternativa in questao["alternativas"]]
        exigir(2 <= len(letras) <= 10 and len(set(letras)) == len(letras)
               and all(letra in set("ABCDEFGHIJ") for letra in letras),
               f"{campo}: confira as letras das alternativas.")
        status, letra = revisada["statusGabarito"], revisada.get("letraCorreta")
        exigir(status in {"definitivo", "provisorio", "anulada"},
               f"{campo}: falta um gabarito identificado e conferido.")
        exigir((status == "anulada" and letra is None)
               or (status != "anulada" and letra in letras),
               f"{campo}: situação ou letra incompatível com o caderno.")
        exigir((questao.get("statusGabarito"), questao.get("letraCorreta")) == (status, letra),
               f"{campo}: situação ou letra diverge do manifesto.")
        exigir(questao.get("fonte", "").strip() and questao.get("fonteGabarito", "").strip(),
               f"{campo}: informe as fontes do caderno e do gabarito.")

        imagem = revisada["imagem"]
        if imagem is None:
            exigir(not questao.get("imagemUrl"), f"{campo}: imagem sem recorte conferido.")
            continue
        imagens += 1
        caminho = (pasta / imagem["arquivo"]).resolve()
        exigir(caminho.is_relative_to(pasta), f"{campo}: recorte fora da pasta do manifesto.")
        dados = caminho.read_bytes()
        png = dados.startswith(b"\x89PNG\r\n\x1a\n")
        webp = dados.startswith(b"RIFF") and dados[8:12] == b"WEBP"
        exigir((png and caminho.suffix.lower() == ".png") or
               (webp and caminho.suffix.lower() == ".webp"), f"{campo}: formato visual inválido.")
        exigir(hashlib.sha256(dados).hexdigest() == imagem["sha256"],
               f"{campo}: bytes diferentes do recorte conferido.")
        url = imagem.get("url")
        if pronto or url or questao.get("imagemUrl"):
            exigir(isinstance(url, str) and urlsplit(url).scheme == "https"
                   and urlsplit(url).hostname and url == questao.get("imagemUrl"),
                   f"{campo}: imagemUrl ausente ou diferente da URL conferida.")
    return len(esperado), imagens


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifesto", type=Path)
    parser.add_argument("lote", type=Path)
    parser.add_argument("--pronto", action="store_true")
    args = parser.parse_args()
    try:
        questoes, imagens = conferir(
            json.loads(args.manifesto.read_text(encoding="utf-8-sig")),
            json.loads(args.lote.read_text(encoding="utf-8-sig")),
            args.manifesto.resolve().parent, args.pronto,
        )
    except (ValueError, KeyError, OSError, TypeError, AttributeError) as erro:
        parser.exit(1, f"Conferência falhou. {erro}\n")
    print(f"Conferência estrutural concluída. {questoes} questões e {imagens} recortes.")


if __name__ == "__main__":
    main()
