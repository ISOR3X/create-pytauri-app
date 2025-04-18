// REF: https://github.com/vitejs/vite/blob/main/packages/create-vite/src/index.ts

import fs from 'fs-extra'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import mri from 'mri'
import * as prompts from '@clack/prompts'
import colors from 'picocolors'
import {Liquid} from 'liquidjs';

const {
    blue, cyan, green, yellow,
} = colors

const argv = mri<{
    template?: string
    help?: boolean
    overwrite?: boolean
}>(process.argv.slice(2), {
    alias: {h: 'help', t: 'template'}, boolean: ['help', 'overwrite'], string: ['template'],
})
const cwd = process.cwd()
const liquid = new Liquid();

// prettier-ignore
const helpMessage = `\
Usage: create-pytauri [OPTION]... [DIRECTORY]

Create a new Pytauri project in JavaScript or TypeScript.
With no arguments, start the CLI in interactive mode.

Options:
  -t, --template NAME        use a specific template

Available templates:
${yellow('vanilla-ts     vanilla')}
${green('vue-ts         vue')}
${cyan('react-ts       react')}
`

type ColorFunc = (str: string | number) => string
type Framework = {
    name: string
    display: string
    color: ColorFunc
    variants: FrameworkVariant[]
}
type FrameworkVariant = {
    name: string
    display: string
    color: ColorFunc
    customCommand?: string
}

const FRAMEWORKS: Framework[] = [{
    name: 'vanilla', display: 'Vanilla', color: yellow, variants: [{
        name: 'vanilla-ts', display: 'TypeScript', color: blue,
    }, {
        name: 'vanilla', display: 'JavaScript', color: yellow,
    },],
}, {
    name: 'vue', display: 'Vue', color: green, variants: [{
        name: 'vue-ts', display: 'TypeScript', color: blue,
    }, {
        name: 'vue', display: 'JavaScript', color: yellow,
    },],
}, {
    name: 'react', display: 'React', color: cyan, variants: [{
        name: 'react-ts', display: 'TypeScript', color: blue,
    }, {
        name: 'react', display: 'JavaScript', color: yellow,
    },],
},]

const TEMPLATES = FRAMEWORKS.map((f) => f.variants.map((v) => v.name)).reduce((a, b) => a.concat(b), [],)

const renameFiles: Record<string, string | undefined> = {
    _gitignore: '.gitignore',
}

const defaultTargetDir = 'pytauri-project'

async function init() {
    const argTargetDir = argv._[0] ? formatTargetDir(String(argv._[0])) : undefined
    const argTemplate = argv.template
    const argOverwrite = argv.overwrite

    const help = argv.help
    if (help) {
        console.log(helpMessage)
        return
    }

    const pkgInfo = pkgFromUserAgent(process.env.npm_config_user_agent)
    const cancel = () => prompts.cancel('Operation cancelled')

    // 1. Get project name and target dir
    let targetDir = argTargetDir
    if (!targetDir) {
        const projectName = await prompts.text({
            message: 'Project name:', defaultValue: defaultTargetDir, placeholder: defaultTargetDir,
        })
        if (prompts.isCancel(projectName)) return cancel()
        targetDir = formatTargetDir(projectName as string)
    }

    // 2. Handle directory if exist and not empty
    if (fs.existsSync(targetDir) && !isEmpty(targetDir)) {
        const overwrite = argOverwrite ? 'yes' : await prompts.select({
            message: (targetDir === '.' ? 'Current directory' : `Target directory "${targetDir}"`) + ` is not empty. Please choose how to proceed:`,
            options: [{
                label: 'Cancel operation', value: 'no',
            }, {
                label: 'Remove existing files and continue', value: 'yes',
            }, {
                label: 'Ignore files and continue', value: 'ignore',
            },],
        })
        if (prompts.isCancel(overwrite)) return cancel()
        switch (overwrite) {
            case 'yes':
                emptyDir(targetDir)
                break
            case 'no':
                cancel()
                return
        }
    }

    // 3. Get package name
    let packageName = path.basename(path.resolve(targetDir))
    if (!isValidPackageName(packageName)) {
        const packageNameResult = await prompts.text({
            message: 'Package name:',
            defaultValue: toValidPackageName(packageName),
            placeholder: toValidPackageName(packageName),
            validate(dir) {
                if (!isValidPackageName(dir)) {
                    return 'Invalid package.json name'
                }
            },
        })
        if (prompts.isCancel(packageNameResult)) return cancel()
        packageName = packageNameResult
    }

    // 4. Choose a framework and variant
    let template = argTemplate
    let hasInvalidArgTemplate = false
    if (argTemplate && !TEMPLATES.includes(argTemplate)) {
        template = undefined
        hasInvalidArgTemplate = true
    }
    if (!template) {
        const framework = await prompts.select({
            message: hasInvalidArgTemplate ? `"${argTemplate}" isn't a valid template. Please choose from below: ` : 'Select a framework:',
            options: FRAMEWORKS.map((framework) => {
                const frameworkColor = framework.color
                return {
                    label: frameworkColor(framework.display || framework.name), value: framework,
                }
            }),
        })
        if (prompts.isCancel(framework)) return cancel()

        const variant = await prompts.select({
            message: 'Select a variant:', options: framework.variants.map((variant) => {
                const variantColor = variant.color
                const command = variant.customCommand ? getFullCustomCommand(variant.customCommand, pkgInfo).replace(/ TARGET_DIR$/, '',) : undefined
                return {
                    label: variantColor(variant.display || variant.name), value: variant.name, hint: command,
                }
            }),
        })
        if (prompts.isCancel(variant)) return cancel()

        template = variant
    }

    const root = path.join(cwd, targetDir)
    fs.mkdirSync(root, {recursive: true})

    const pkgManager = pkgInfo ? pkgInfo.name : 'npm'

    prompts.log.step(`Scaffolding project in ${root}...`)

    const rootTemplateDir = path.resolve(fileURLToPath(import.meta.url), '../../templates',)
    const templateDir = path.resolve(rootTemplateDir, `template-${template}`)

    const write = (file: string, content?: string) => {
        const targetPath = path.join(root, renameFiles[file] ?? file)
        if (content) {
            fs.writeFileSync(targetPath, content)
        } else {
            copy(path.join(templateDir, file), targetPath)
        }
    }

    const files = fs.readdirSync(templateDir)
    for (const file of files.filter((f) => f !== 'package.json')) {
        write(file)
    }

    // Update package.json with package name.
    const pkg = JSON.parse(fs.readFileSync(path.join(templateDir, `package.json`), 'utf-8'),)

    pkg.name = packageName

    write('package.json', JSON.stringify(pkg, null, 2) + '\n')

    // Copy python code
    const pythonTemplateDir = path.join(rootTemplateDir, "_base_", "src-python")
    const pythonRoot = path.join(root, 'src-tauri', 'src-python', 'src')
    copyDir(pythonTemplateDir, path.join(root, 'src-tauri', 'src-python'))
    await renameDirectory(path.join(pythonRoot, '{{packageName}}'), path.join(pythonRoot, packageName))
    await processTomlFile(path.join(root, 'src-tauri', 'src-python', "pyproject.toml"), {project_name: packageName})

    // Show next steps to user.
    let doneMessage = ''
    const cdProjectName = path.relative(cwd, root)
    doneMessage += `Done. Now run:\n`
    if (root !== cwd) {
        doneMessage += `\n  cd ${cdProjectName.includes(' ') ? `"${cdProjectName}"` : cdProjectName}`
    }
    doneMessage += `\n  ${pkgManager} install`
    doneMessage += `\n  ${pkgManager} run dev`
    prompts.outro(doneMessage)
}

function formatTargetDir(targetDir: string) {
    return targetDir.trim().replace(/\/+$/g, '')
}

function copy(src: string, dest: string) {
    const stat = fs.statSync(src)
    if (stat.isDirectory()) {
        copyDir(src, dest)
    } else {
        fs.copyFileSync(src, dest)
    }
}

function isValidPackageName(projectName: string) {
    return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(projectName,)
}

function toValidPackageName(projectName: string) {
    return projectName
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/^[._]/, '')
        .replace(/[^a-z\d\-~]+/g, '-')
}

function copyDir(srcDir: string, destDir: string) {
    fs.mkdirSync(destDir, {recursive: true})
    for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.resolve(srcDir, file)
        const destFile = path.resolve(destDir, file)
        copy(srcFile, destFile)
    }
}

function isEmpty(path: string) {
    const files = fs.readdirSync(path)
    return files.length === 0 || (files.length === 1 && files[0] === '.git')
}

function emptyDir(dir: string) {
    if (!fs.existsSync(dir)) {
        return
    }
    for (const file of fs.readdirSync(dir)) {
        if (file === '.git') {
            continue
        }
        fs.rmSync(path.resolve(dir, file), {recursive: true, force: true})
    }
}

interface PkgInfo {
    name: string
    version: string
}

function pkgFromUserAgent(userAgent: string | undefined): PkgInfo | undefined {
    if (!userAgent) return undefined
    const pkgSpec = userAgent.split(' ')[0]
    const pkgSpecArr = pkgSpec.split('/')
    return {
        name: pkgSpecArr[0], version: pkgSpecArr[1],
    }
}


function getFullCustomCommand(customCommand: string, pkgInfo?: PkgInfo) {
    const pkgManager = pkgInfo ? pkgInfo.name : 'npm'
    const isYarn1 = pkgManager === 'yarn' && pkgInfo?.version.startsWith('1.')

    return (customCommand
        .replace(/^npm create (?:-- )?/, () => {
            // `bun create` uses it's own set of templates,
            // the closest alternative is using `bun x` directly on the package
            if (pkgManager === 'bun') {
                return 'bun x create-'
            }
            // pnpm doesn't support the -- syntax
            if (pkgManager === 'pnpm') {
                return 'pnpm create '
            }
            // For other package managers, preserve the original format
            return customCommand.startsWith('npm create -- ') ? `${pkgManager} create -- ` : `${pkgManager} create `
        })
        // Only Yarn 1.x doesn't support `@version` in the `create` command
        .replace('@latest', () => (isYarn1 ? '' : '@latest'))
        .replace(/^npm exec/, () => {
            // Prefer `pnpm dlx`, `yarn dlx`, or `bun x`
            if (pkgManager === 'pnpm') {
                return 'pnpm dlx'
            }
            if (pkgManager === 'yarn' && !isYarn1) {
                return 'yarn dlx'
            }
            if (pkgManager === 'bun') {
                return 'bun x'
            }
            // Use `npm exec` in all other cases,
            // including Yarn 1.x and other custom npm clients.
            return 'npm exec'
        }))
}

const renameDirectory = async (oldDir: string, newDir: string) => {
    try {
        if (await fs.pathExists(oldDir) && !(await fs.pathExists(newDir))) {
            await fs.rename(oldDir, newDir);
            // console.log(`Directory renamed from "${oldDir}" to "${newDir}"`);
        } else {
            console.log("Directory rename failed. Either source doesn't exist or target exists.");
        }
    } catch (err) {
        console.error('Error renaming directory:', err);
    }
};

const processTomlFile = async (filePath: string, context: any) => {
    try {
        const tomlContent = fs.readFileSync(filePath, 'utf-8');
        const rendered = await liquid.parseAndRender(tomlContent, context);
        fs.writeFileSync(filePath, rendered, 'utf-8');
        // console.log(`TOML file processed: ${filePath}`);
    } catch (err) {
        console.error('Error processing TOML file:', err);
    }
};

init().catch((e) => {
    console.error(e)
})
