# editable-diff

Мод для Claude Code: панель «Правки» со всеми файлами, которые Claude изменил через Edit или Write.

- зелёный/красный diff против версии до первой правки Claude, с 5 строками контекста вокруг изменений;
- правка прямо в панели: клик по строке, набор текста, Ctrl/Cmd+Z, Ctrl/Cmd+S;
- «Сохранить» пишет файл на диск и сообщает Claude, что файл нужно перечитать;
- если Claude меняет файл, пока у вас несохранённые правки, панель предлагает взять его версию или оставить свою;
- «Очистить буфер» убирает список (файлы на диске не трогает).

Панель открывается сама при первой правке Claude или командой `/editable-diff`.

## Установка

В терминальной сессии Claude Code:

```
/plugin install editable-diff --marketplace tg-bomze/editable-diff
```

Из shell:

```bash
claude plugin install editable-diff --marketplace tg-bomze/editable-diff
```

В десктоп-приложении: «+» рядом с полем ввода → Plugins → Add marketplace `tg-bomze/editable-diff` → Add plugin.

## Разработка

```bash
claude plugin validate .
```

```bash
claude plugin test .
```
